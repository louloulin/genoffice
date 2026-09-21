/**
 * IPC event broadcast — lets a handler push a typed event back to the
 * renderer's SSE stream for the current session.
 *
 * The dispatcher in `apps/web-server/src/index.ts` builds an `event`
 * object whose `sender.send(channel, ...args)` already pushes the encoded
 * frame onto the per-session SSE connection. This module is the typed
 * wrapper: handlers import `sendIpcEvent` and pass their `event` argument
 * through, so the call site reads like the desktop equivalent
 * (`event.sender.send('dirtyChanged', { dirty })`).
 *
 * Why a separate module instead of inlining: every save / dirty handler
 * would otherwise copy the same four-line type-narrow + null guard, and
 * any future change to the envelope shape (add a `version` field, a
 * `correlationId`, etc.) would have to land in 7+ places. Centralising
 * keeps the renderer contract in one place.
 *
 * Stable event names (sdk1.md §2.1.B):
 *   - `saved`         — payload { path: string, version: number, bytes?: number, format?: string }
 *   - `dirtyChanged`  — payload { dirty: boolean }
 *
 * Both are part of the public SDK EditorEvent union
 * (`apps/sdk/src/types.ts:139`).
 */

interface IpcSender {
  id: number
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

interface IpcEventLike {
  sender?: IpcSender
}

export function sendIpcEvent(event: unknown, channel: string, payload: unknown): boolean {
  const sender = (event as IpcEventLike | null | undefined)?.sender
  if (!sender || sender.isDestroyed()) return false
  try {
    sender.send(channel, payload)
    return true
  } catch {
    // The dispatcher logs SSE write failures; swallow here so a broken
    // push channel never breaks the handler return value.
    return false
  }
}

/** True when `event` has a live, attached SSE sender. Handlers can use
 *  this to skip work that's only useful to embed consumers. */
export function hasLiveIpcSender(event: unknown): boolean {
  const sender = (event as IpcEventLike | null | undefined)?.sender
  return Boolean(sender && !sender.isDestroyed())
}
