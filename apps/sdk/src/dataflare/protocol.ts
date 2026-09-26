/**
 * Dataflare embed envelope protocol — `genoffice-dataflare/v1`.
 *
 * The protocol sits between a host page (Dataflarework) and a child iframe
 * running a GenOffice editor (docs / sheets / slides / etc.). Both sides
 * exchange messages through `window.postMessage` with two-part origin +
 * source guards enforced by `guest.ts` and `host.ts`.
 *
 * 7 envelope kinds:
 *   - command            : host → editor  business command
 *   - event              : editor → host  business event
 *   - request            : editor → host  one-shot HTTP proxy
 *   - response           : host  → editor response to the one-shot
 *   - stream-request     : editor → host  open SSE proxy
 *   - stream-event       : host  → editor single SSE event
 *   - stream-close       : host  → editor SSE terminated
 *
 * Why a separate protocol (not reusing SDK v1 envelope): the SDK envelope
 * (`apps/sdk/src/envelope.ts`) carries editor ↔ host commands for the
 * embeddable editor inside an iframe. This protocol carries the editor app
 * running inside a third-party parent shell — different trust boundary, a
 * different `kind` vocabulary, and a different shape (request/response with
 * an ArrayBuffer body that needs `Transferable`).
 *
 * Re-exported from the SDK root for discoverability; consumers import from
 * `@genoffice/web-sdk/dataflare/guest` / `./dataflare/host` to keep the
 * bridge out of the main bundle.
 */

export const DATAFLARE_EMBED_PROTOCOL = 'genoffice-dataflare/v1' as const

export type DataflareEmbedKind =
  | 'command'
  | 'event'
  | 'request'
  | 'response'
  | 'stream-request'
  | 'stream-event'
  | 'stream-close'

export interface EmbedEnvelope<T> {
  protocol: typeof DATAFLARE_EMBED_PROTOCOL
  kind: DataflareEmbedKind
  /** Required for request/response/stream-*; optional on command/event. */
  sessionId?: string
  payload: T
}

/**
 * Detect whether an arbitrary `unknown` value looks like a Dataflare envelope.
 * Intentionally permissive — the caller still has to check `kind` and `payload`
 * shape before acting. Use this before feeding an unknown `MessageEvent.data`
 * into the typed parsers in `guest.ts`.
 */
export function isDataflareEnvelope(value: unknown): value is EmbedEnvelope<unknown> {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EmbedEnvelope<unknown>>
  return candidate.protocol === DATAFLARE_EMBED_PROTOCOL && typeof candidate.kind === 'string'
}

/** Encode + send a typed envelope through `target.postMessage`. */
export function postEnvelope<T>(
  target: Window,
  envelope: EmbedEnvelope<T>,
  origin: string,
  transfer?: Transferable[],
): void {
  if (transfer && transfer.length > 0) {
    target.postMessage(envelope, origin, transfer)
    return
  }
  target.postMessage(envelope, origin)
}

/** Build an envelope with the protocol constant pre-filled. */
export function makeEnvelope<T>(
  kind: DataflareEmbedKind,
  payload: T,
  sessionId?: string,
): EmbedEnvelope<T> {
  return {
    protocol: DATAFLARE_EMBED_PROTOCOL,
    kind,
    ...(sessionId ? { sessionId } : {}),
    payload,
  }
}