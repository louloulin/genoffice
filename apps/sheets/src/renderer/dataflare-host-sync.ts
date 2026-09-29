/**
 * Dataflare host documents (drive / knowledge xlsx) — the sheets half of the
 * "save back to the host" loop.
 *
 * The host hands the workbook down as bytes; the web-bridge parks them in a
 * managed temp file and the renderer edits that copy through the normal
 * open-path / workbook:save pipeline. Saving is where the flows diverge: after
 * workbook:save rewrote the temp copy, its bytes have to be pushed to the host
 * as a new revision (optimistic lock, 409 → conflict).
 *
 * That push is deliberately *not* folded into saveWorkbookEdits: a two-phase
 * save calls it twice and would publish the half-applied first phase as a host
 * revision. save-actions calls {@link HostDocumentSync.sync} once, after the
 * last phase.
 *
 * A failed push does not roll the local save back. workbook:save patches the
 * temp file in place and the renderer reopens it, so the journal is drained
 * and a retry of the same edits would apply them twice. Instead the sync stays
 * `pending`, and the next Save — even with nothing new in the journal —
 * re-sends the current bytes.
 */
import type { HostDocumentSyncResult } from '../shared/desktop-api'

export interface HostDocumentSyncDeps {
  /** Current bytes of a managed file (the saved temp copy). */
  readFileBytes: (path: string) => Promise<ArrayBuffer>
  /** Upload bytes to the host document as a new revision. */
  saveToHost: (
    path: string,
    bytes: ArrayBuffer,
  ) => Promise<{ ok: true } | { ok: false; reason: string; error: string }>
  /** True when the host's init named a host-owned document (drive / knowledge). */
  isHostDocument: () => boolean
}

export interface HostDocumentSync {
  /** The temp copy the host document was opened from; resets `pending`. */
  setHostDocumentPath(path: string): void
  /** Push the saved workbook at `path` to the host (no-op for other files). */
  sync(path: string | undefined): Promise<HostDocumentSyncResult>
  /** A previous push failed (not a conflict): the local copy is ahead of the host. */
  hasPending(): boolean
}

export function createHostDocumentSync(deps: HostDocumentSyncDeps): HostDocumentSync {
  let hostPath: string | null = null
  let pending = false

  return {
    setHostDocumentPath(path) {
      hostPath = path
      pending = false
    },
    hasPending: () => pending,
    async sync(path) {
      if (!hostPath || path !== hostPath || !deps.isHostDocument()) return { status: 'not-host' }
      try {
        const bytes = await deps.readFileBytes(hostPath)
        const saved = await deps.saveToHost(hostPath, bytes)
        if (saved.ok) {
          pending = false
          return { status: 'synced' }
        }
        const conflict = saved.reason === 'external-modified'
        // Re-sending after a conflict would only 409 again: the user has to
        // reopen from the host's current version.
        pending = !conflict
        return { status: 'failed', error: saved.error, conflict }
      } catch (error) {
        pending = true
        return {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          conflict: false,
        }
      }
    },
  }
}
