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

/**
 * Construct the iframe URL that loads the GenOffice editor in embed mode.
 * The web-server responds with HTML that:
 *   1. validates the nonce + JWT,
 *   2. sets the `auth_token` cookie (so the iframe's `EventSource` works),
 *   3. injects the `genoffice-dataflare/v1` bridge listener.
 */
export function buildDataflareEmbedUrl(input: DataflareEmbedUrlInput): string {
  const params = new URLSearchParams({
    embed: '1',
    app: input.app,
    doc: input.documentId,
    jwt: input.jwt,
    sessionId: input.sessionId,
    nonce: input.nonce,
  })
  if (input.readonly !== undefined) params.set('readonly', String(input.readonly))
  if (input.locale) params.set('lang', input.locale)
  if (input.theme) params.set('theme', input.theme)
  const base = input.baseUrl.replace(/\/$/, '')
  return `${base}/apps/${input.app}/embedded?${params.toString()}`
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