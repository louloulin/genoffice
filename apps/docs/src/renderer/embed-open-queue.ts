import type { OpenDocxResult } from '../shared/ipc'

/**
 * Handoff slot for the embed open flow. `web-bridge.ts` publishes the
 * opened document here before dispatching `dataflare:open-document`; App
 * consumes whatever is left after attaching its listener.
 *
 * The event alone used to be the whole handoff, and it raced: the openBytes
 * round trip is a local call that can resolve inside a few milliseconds,
 * while the listener only exists one React commit after the editor mounts.
 * When the dispatch won, it landed on no listener, the boot stayed on the
 * blank document, and every subsequent dirty/save applied to the wrong one.
 */
let pending: OpenDocxResult | null = null

export function publishEmbedOpen(result: OpenDocxResult): void {
  pending = result
}

export function consumeEmbedOpen(): OpenDocxResult | null {
  const out = pending
  pending = null
  return out
}

/**
 * Boot-coordination state. The boot blank document bumps `openGeneration`,
 * and an embed open that is still parsing when it does gets discarded as
 * "superseded" — which the fast local open path (bytes in hand within
 * milliseconds) hits every time. App's boot therefore waits for the embed
 * open to settle before falling back to blank; these primitives carry that
 * signal without App needing to know how the open flows through web-bridge.
 */
let inFlight = false
let settled = false
let settleNotify: (() => void) | null = null

/** web-bridge calls this when the host document open actually starts (openBytes). */
export function markEmbedOpenInFlight(): void {
  inFlight = true
  settled = false
}

/** App calls this when an embed-sourced loadFile resolves (any outcome). */
export function notifyEmbedOpenSettled(): void {
  inFlight = false
  settled = true
  const n = settleNotify
  settleNotify = null
  n?.()
}

/**
 * Resolves true when the embed open settled (applied, or failed into its own
 * blank fallback), false on timeout or when no open is in flight. App's boot
 * only owes a blank document when this returns false.
 */
export function waitForEmbedOpenSettled(timeoutMs: number): Promise<boolean> {
  if (settled || !inFlight) return Promise.resolve(settled)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleNotify = null
      resolve(false)
    }, timeoutMs)
    settleNotify = () => {
      clearTimeout(timer)
      resolve(true)
    }
  })
}
