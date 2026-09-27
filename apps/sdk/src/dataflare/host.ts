/**
 * Dataflare embed — host (parent shell) side of the `genoffice-dataflare/v1`
 * bridge.
 *
 * The host runs in Dataflarework's parent page. It owns the iframe element
 * and is responsible for:
 *   - minting the sessionId + JWT + nonce (via the GenOffice web-server REST
 *     API, see `apps/web-server/src/api/v1/embed/*`)
 *   - serving the iframe URL (`buildDataflareEmbedUrl`)
 *   - proxying HTTP and SSE requests from the iframe to its own backend
 *     (i.e. `requestDataflareGuest` / `requestDataflareStreamGuest`)
 *   - sending business commands to the iframe (`postCommandToGuest`)
 *
 * This module provides the typed wrappers. Network plumbing (fetch, EventSource,
 * cookie sync) is the consumer's responsibility — pass them via `fetchImpl` /
 * `eventSourceFactory`. The host module itself is deliberately zero-dep.
 *
 * Why no `mount` helper: the iframe lifecycle is the consumer's choice (route
 * change, dialog, fixed pane). The SDK just gives you the contract — fill in
 * `buildDataflareEmbedUrl`, then wire `installDataflareHostBridge` onto the
 * `window.message` event.
 */

import {
  DATAFLARE_EMBED_PROTOCOL,
  isDataflareEnvelope,
  makeEnvelope,
  postEnvelope,
  type EmbedEnvelope,
  type DataflareEmbedKind,
} from './protocol'
import { buildEmbedUrl } from '../embed-url'
import type { EditorApp, EditorLang, EditorTheme } from '../types'
import type {
  DataflareEmbedCommand,
  DataflareParentRequest,
  DataflareParentResponse,
  DataflareParentStreamClose,
  DataflareParentStreamEvent,
  DataflareParentStreamRequest,
  GenOfficeEmbedEvent,
  DataflareEmbedUrlInput,
  DataflareHostBridgeHandlers,
} from './types'

// ── Build the iframe URL ────────────────────────────────────────────────────

/** Stand-in origin so a relative `baseUrl` can go through `new URL()`. */
const RELATIVE_BASE_PLACEHOLDER = 'http://dataflare-embed.invalid'

/**
 * Construct the iframe URL that loads the GenOffice editor in embed mode.
 *
 * The shape is the web-server's `/embed/:docId` contract
 * (`apps/web-server/src/embed/index.ts` `parseEmbedQuery`): the document id is
 * a **path** segment and the credential parameter is named **`token`** — the
 * server answers `400 missing ?token=` for anything else. `openEmbedSession`
 * defaults to this builder, so a mismatch here breaks every embed at the first
 * hop rather than at the bridge.
 *
 * The web-server responds with HTML that:
 *   1. injects the app's own `index.html` under a `<base href="/">` wrapper,
 *   2. sets the `auth_token` cookie (so the iframe's `EventSource` works),
 *   3. injects the `'1.0'` standalone bridge (`/embed/static/bridge.js`).
 *
 * Note (3) is *not* the `genoffice-dataflare/v1` bridge: the dataflare guest is
 * installed by the editor app's own bundle, not by the server. See
 * `installDataflareHostBridge` below for the host half of that pairing.
 */
export function buildDataflareEmbedUrl(input: DataflareEmbedUrlInput): string {
  // Delegate to the canonical builder rather than re-deriving the query string:
  // `/apps/{app}/embedded?doc=&jwt=` was an unroutable shape that the server
  // never served, and a hand-rolled second copy of the vocabulary is how it
  // drifted. `buildEmbedUrl` is the one tested against `parseEmbedQuery`.
  const base = input.baseUrl.replace(/\/+$/, '')
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(base)
  const url = buildEmbedUrl({
    // `new URL()` needs an origin. The placeholder is stripped below, and the
    // prefix is re-attached there too: `/embed/…` is an absolute path, so
    // resolving it against `…/office-engine` would drop the prefix rather
    // than append to it.
    host: absolute ? base : RELATIVE_BASE_PLACEHOLDER,
    documentId: input.documentId,
    app: input.app as EditorApp,
    token: input.jwt,
    nonce: input.nonce,
    sessionId: input.sessionId,
    mode: input.readonly === undefined ? undefined : input.readonly ? 'view' : 'edit',
    // the dataflare vocabulary says 'system'; the editor's says 'auto'
    theme: input.theme === 'system' ? 'auto' : (input.theme as EditorTheme | undefined),
    lang: input.locale as EditorLang | undefined,
  })
  if (absolute) return url
  const parsed = new URL(url)
  return `${base}${parsed.pathname}${parsed.search}`
}

// ── Inbound: install the host bridge (parses guest envelopes) ──────────────

/**
 * Install the host-side bridge on `window`. Returns an uninstall function
 * that detaches the message listener.
 *
 * The host passes `iframe.contentWindow` as `guestWindow`. Every incoming
 * `MessageEvent` is validated on:
 *
 *   1. `event.source === guestWindow`         (iframe identity)
 *   2. `event.origin === expectedOrigin`      (e.g. `new URL(baseUrl).origin`)
 *   3. envelope shape (`protocol`, `kind`, `sessionId`)
 *
 * If `onStreamRequest` returns void, the host should manage the abort
 * controller externally and call the `close` callback when the upstream
 * SSE terminates.
 */
export function installDataflareHostBridge(
  guestWindow: Window,
  expectedOrigin: string,
  sessionId: string,
  handlers: DataflareHostBridgeHandlers,
): () => void {
  if (typeof window === 'undefined') return () => {}
  const onMessage = async (event: MessageEvent<unknown>) => {
    if (event.source !== guestWindow || event.origin !== expectedOrigin) return
    if (!isDataflareEnvelope(event.data)) return
    const envelope = event.data as EmbedEnvelope<unknown>
    if (envelope.sessionId !== sessionId) return
    if (envelope.kind === 'event') {
      handlers.onEvent?.(envelope.payload as GenOfficeEmbedEvent)
      return
    }
    if (envelope.kind === 'command') {
      handlers.onCommand?.(envelope.payload as DataflareEmbedCommand)
      return
    }
    if (envelope.kind === 'request' && handlers.onRequest) {
      const request = envelope.payload as DataflareParentRequest
      try {
        const response = await handlers.onRequest(request)
        sendResponseToGuest(guestWindow, expectedOrigin, sessionId, {
          type: 'http-response',
          requestId: request.requestId,
          sessionId: request.sessionId,
          ...response,
        })
      } catch (err) {
        sendResponseToGuest(guestWindow, expectedOrigin, sessionId, {
          type: 'http-response',
          requestId: request.requestId,
          sessionId: request.sessionId,
          status: 0,
          headers: {},
          body: new TextEncoder().encode(
            err instanceof Error ? err.message : 'request failed',
          ).buffer,
        })
      }
      return
    }
    if (envelope.kind === 'stream-request' && handlers.onStreamRequest) {
      const request = envelope.payload as DataflareParentStreamRequest
      const ac = new AbortController()
      handlers.onStreamRequest(
        request,
        (event) => {
          postEnvelope(
            guestWindow,
            makeEnvelope<DataflareParentStreamEvent>('stream-event', {
              type: 'http-stream-event',
              requestId: request.requestId,
              sessionId: request.sessionId,
              ...event,
            }, sessionId),
            expectedOrigin,
          )
        },
        (status) => {
          postEnvelope(
            guestWindow,
            makeEnvelope<DataflareParentStreamClose>('stream-close', {
              type: 'http-stream-close',
              requestId: request.requestId,
              sessionId: request.sessionId,
              status,
            }, sessionId),
            expectedOrigin,
          )
        },
        ac.signal,
      )
      // Best-effort: if the guest unsubscribes by reloading the iframe, the
      // host can't observe it directly. The consumer should `ac.abort()` on
      // their own teardown.
      return
    }
  }
  window.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('message', onMessage)
  }
}

// ── Outbound: command → guest (host pushes a business command) ─────────────

export function postCommandToGuest(
  guestWindow: Window,
  expectedOrigin: string,
  sessionId: string,
  command: DataflareEmbedCommand,
): void {
  const envelope = makeEnvelope<DataflareEmbedCommand>('command', command, sessionId)
  postEnvelope(guestWindow, envelope, expectedOrigin)
}

/** Send a one-shot HTTP response back to the guest. Internal helper. */
function sendResponseToGuest(
  guestWindow: Window,
  expectedOrigin: string,
  sessionId: string,
  response: DataflareParentResponse,
): void {
  const envelope = makeEnvelope<DataflareParentResponse>('response', response, sessionId)
  const transfer = response.body instanceof ArrayBuffer ? [response.body] : []
  postEnvelope(guestWindow, envelope, expectedOrigin, transfer)
}

// ── Utility re-export ──────────────────────────────────────────────────────

export { DATAFLARE_EMBED_PROTOCOL, isDataflareEnvelope, makeEnvelope }
export type { EmbedEnvelope, DataflareEmbedKind }

export type {
  DataflareEmbedCommand,
  DataflareParentRequest,
  DataflareParentResponse,
  DataflareParentStreamEvent,
  DataflareParentStreamClose,
  DataflareParentStreamRequest,
  GenOfficeEmbedEvent,
  DataflareOfficeContext,
  DataflareGlobalState,
  DataflareEmbedBridgeHandlers,
  DataflareHostBridgeHandlers,
  DataflareEmbedUrlInput,
} from './types'