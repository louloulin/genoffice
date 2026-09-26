/**
 * Dataflare embed — guest (iframe) side of the `genoffice-dataflare/v1`
 * bridge.
 *
 * The guest runs inside the GenOffice editor page (apps/docs, etc.). The
 * host is the parent shell (Dataflarework). The two exchange envelopes via
 * `window.parent.postMessage`. Every incoming message is validated on three
 * axes:
 *
 *   1. `event.source === window.parent`   (window identity)
 *   2. `event.origin === expectedOrigin` (computed from `document.referrer`
 *                                       or `window.location.ancestorOrigins`)
 *   3. envelope shape: `protocol`, `kind`, `sessionId`, `payload`
 *
 * All three must hold, in that order. The bridge keeps one active sessionId
 * per page; commands that reference a different sessionId are dropped.
 *
 * Public surface (the iframe calls these):
 *   - `installDataflareEmbedBridge(handlers)` : start listening, emit `ready`
 *   - `postToEmbedParent(event)`              : emit a business event
 *   - `requestDataflareParent(request)`       : one-shot HTTP proxy
 *   - `requestDataflareStreamParent(req, ...)` : SSE proxy subscription
 *   - `getDataflareEmbedSessionId()`          : current session id or null
 *   - `isEmbeddedInHost()`                    : `window.parent !== window`
 *   - `isStreamEventEnvelope(value)`          : narrow a MessageEvent
 *
 * Transplanted from `apps/docs/src/shared/embed-bridge.ts` (269 LoC). The
 * original file becomes a thin re-export shim.
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
  DataflareEmbedBridgeHandlers,
  DataflareEmbedCommand,
  DataflareParentRequest,
  DataflareParentResponse,
  DataflareParentStreamEvent,
  DataflareParentStreamClose,
  DataflareParentStreamRequest,
  GenOfficeEmbedEvent,
} from './types'

// ── Session state (process-local; one active session per guest page) ───────

let activeSessionId: string | null = null

export function getDataflareEmbedSessionId(): string | null {
  return activeSessionId
}

// ── Origin detection ───────────────────────────────────────────────────────

/**
 * The parent shell's origin. We can't trust `event.origin` directly (it could
 * be the guest's own origin in a misconfigured embed) so we derive the
 * expected value from `document.referrer` first, falling back to
 * `window.location.ancestorOrigins[0]`. The matched origin is the one we
 * require on every incoming `MessageEvent`.
 */
export function parentOrigin(): string | null {
  if (typeof document !== 'undefined' && document.referrer) {
    try {
      return new URL(document.referrer).origin
    } catch {
      // fall through
    }
  }
  if (typeof window !== 'undefined') {
    const ancestorOrigin = window.location.ancestorOrigins?.[0]
    if (ancestorOrigin) return ancestorOrigin
  }
  return null
}

export function isEmbeddedInHost(): boolean {
  return typeof window !== 'undefined' && window.parent !== window
}

// ── Envelope guards ────────────────────────────────────────────────────────

function isCommandEnvelope(value: unknown): value is EmbedEnvelope<DataflareEmbedCommand> {
  if (!isDataflareEnvelope(value)) return false
  return value.kind === 'command'
}

/** Narrow a `MessageEvent.data` to a stream event or stream close. */
export function isStreamEventEnvelope(
  value: unknown,
): value is EmbedEnvelope<DataflareParentStreamEvent | DataflareParentStreamClose> {
  if (!isDataflareEnvelope(value)) return false
  return value.kind === 'stream-event' || value.kind === 'stream-close'
}

function isResponseEnvelope(value: unknown): value is EmbedEnvelope<DataflareParentResponse> {
  if (!isDataflareEnvelope(value)) return false
  return value.kind === 'response'
}

// ── Outbound: event → parent ────────────────────────────────────────────────

export function postToEmbedParent(payload: GenOfficeEmbedEvent): void {
  const origin = parentOrigin()
  if (!isEmbeddedInHost() || !origin) return
  const envelope = makeEnvelope<GenOfficeEmbedEvent>('event', payload, activeSessionId ?? undefined)
  postEnvelope(window.parent, envelope, origin)
}

// ── Outbound: request → parent (one-shot, with timeout) ────────────────────

/**
 * Ask the parent shell to perform an HTTP call on our behalf. Returns a
 * promise that resolves with the full response (status, headers, body as
 * ArrayBuffer) or rejects after 60 s with `'Dataflare parent request timed out'`.
 *
 * The `file.bytes` ArrayBuffer is sent as a `Transferable` to avoid copying.
 */
export function requestDataflareParent(request: DataflareParentRequest): Promise<DataflareParentResponse> {
  const origin = parentOrigin()
  if (
    !isEmbeddedInHost() ||
    !origin ||
    !activeSessionId ||
    request.sessionId !== activeSessionId
  ) {
    return Promise.reject(new Error('Dataflare parent bridge is unavailable'))
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('Dataflare parent request timed out'))
    }, 60_000)
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== origin) return
      if (!isResponseEnvelope(event.data)) return
      if (event.data.sessionId !== request.sessionId) return
      const response = event.data.payload
      if (
        !response ||
        response.type !== 'http-response' ||
        response.sessionId !== request.sessionId ||
        response.requestId !== request.requestId
      ) {
        return
      }
      window.clearTimeout(timeout)
      window.removeEventListener('message', onMessage)
      resolve(response)
    }
    window.addEventListener('message', onMessage)
    const envelope = makeEnvelope<DataflareParentRequest>('request', request, request.sessionId)
    const transfer = request.file ? [request.file.bytes] : []
    postEnvelope(window.parent, envelope, origin, transfer)
  })
}

// ── Outbound: stream-request → parent (SSE subscription) ────────────────────

/**
 * Subscribe to an SSE stream proxied through the parent shell. The parent
 * opens the SSE connection to the upstream URL and forwards each event as
 * a `stream-event` envelope. The bridge closes when the parent sends a
 * `stream-close` envelope (with the upstream status code).
 *
 * Returns an unsubscribe function: call it to detach the message listener
 * and stop receiving events.
 */
export function requestDataflareStreamParent(
  request: DataflareParentStreamRequest,
  onEvent: (event: DataflareParentStreamEvent) => void,
  onClose: (status: number) => void,
  onError: (error: Error) => void,
): () => void {
  const origin = parentOrigin()
  if (
    !isEmbeddedInHost() ||
    !origin ||
    !activeSessionId ||
    request.sessionId !== activeSessionId
  ) {
    onError(new Error('Dataflare stream bridge is unavailable'))
    return () => {}
  }
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== origin) return
    if (!isStreamEventEnvelope(event.data)) return
    if (event.data.sessionId !== request.sessionId) return
    const payload = event.data.payload
    if (!payload || payload.requestId !== request.requestId) return
    if (event.data.kind === 'stream-event') {
      onEvent(payload as DataflareParentStreamEvent)
    } else if (event.data.kind === 'stream-close') {
      window.removeEventListener('message', onMessage)
      onClose((payload as DataflareParentStreamClose).status)
    }
  }
  window.addEventListener('message', onMessage)
  const envelope = makeEnvelope<DataflareParentStreamRequest>(
    'stream-request',
    request,
    request.sessionId,
  )
  postEnvelope(window.parent, envelope, origin)
  return () => {
    window.removeEventListener('message', onMessage)
  }
}

// ── Inbound: install the bridge on the guest side ───────────────────────────

/**
 * Install the bridge on the guest side. Returns an uninstall function that
 * removes the message listener and clears the active sessionId.
 *
 * Accepts either a single command callback (legacy shape) or a typed
 * `DataflareEmbedBridgeHandlers` object — same as the original.
 *
 * On install:
 *   1. Listen for `command` envelopes from the parent.
 *   2. On `init` command, capture the sessionId (rejected if empty).
 *   3. Drop any command whose sessionId doesn't match the captured one.
 *   4. Emit `ready` (capabilities) and `global-state-request` to the parent
 *      so the host can push current state.
 *   5. Route `global-state-update` commands to `handlers.onGlobalState`,
 *      everything else to `handlers.onCommand`.
 */
export function installDataflareEmbedBridge(
  onCommandOrHandlers: ((command: DataflareEmbedCommand) => void) | DataflareEmbedBridgeHandlers,
): () => void {
  const handlers: DataflareEmbedBridgeHandlers =
    typeof onCommandOrHandlers === 'function'
      ? { onCommand: onCommandOrHandlers }
      : onCommandOrHandlers
  const origin = parentOrigin()
  if (!isEmbeddedInHost() || !origin) return () => {}
  let sessionId: string | null = null
  const onMessage = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || event.origin !== origin) return
    if (!isCommandEnvelope(event.data)) return
    const envelope = event.data as EmbedEnvelope<DataflareEmbedCommand>
    const command = envelope.payload
    if (command.type === 'init') {
      const normalized = command.sessionId.trim()
      if (!normalized) return
      activeSessionId = normalized
      sessionId = normalized
    } else if (!sessionId || envelope.sessionId !== sessionId) {
      return
    }
    if (command.type === 'global-state-update') {
      handlers.onGlobalState?.(command.state, command.revision)
      return
    }
    handlers.onCommand(command)
  }
  window.addEventListener('message', onMessage)
  postToEmbedParent({
    type: 'ready',
    capabilities: [
      'document-context',
      'ai-translation',
      'ai-assistant',
      'host-commands',
      'global-state',
    ],
  })
  postToEmbedParent({ type: 'global-state-request' })
  return () => {
    window.removeEventListener('message', onMessage)
    activeSessionId = null
  }
}

// ── Utility re-export (escape hatch for advanced consumers) ─────────────────

export { DATAFLARE_EMBED_PROTOCOL, isDataflareEnvelope, makeEnvelope }
export type { EmbedEnvelope, DataflareEmbedKind }

export type {
  DataflareOfficeContext,
  DataflareGlobalState,
  DataflareEmbedCommand,
  GenOfficeEmbedEvent,
  DataflareParentRequest,
  DataflareParentResponse,
  DataflareParentStreamRequest,
  DataflareParentStreamEvent,
  DataflareParentStreamClose,
  DataflareEmbedBridgeHandlers,
} from './types'