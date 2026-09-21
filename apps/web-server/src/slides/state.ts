/**
 * Slides read-only query channels — get-render-slides, get-animations,
 * get-chart-data, get-comments, get-header-footer, get-layouts, etc.
 *
 * Plus the in-memory session registry that backs the real `slides:apply-txn`
 * and `slides:save` implementations. Without this registry the edit pipeline
 * has nowhere to keep the `OpenedPptx` between ops and a save, so every
 * edit answered `{ ok: true }` while losing the bytes.
 *
 * Concurrency: sessions are keyed by absolute path (the value the renderer
 * hands back to every `slides:*` channel). A long-running server with many
 * open tabs would otherwise hold every `OpenedPptx` resident forever; the
 * registry caps at 32 sessions and evicts the oldest.
 */
import { join } from 'node:path'
import { registerHandle, FILES_DIR, storageKeyFromPath } from '../common/index'
import { openPptx, savePptx, type OpenedPptx } from '@genoffice/pptx-engine'

const MAX_SLIDES_SESSIONS = 32

interface SlidesSessionInfo {
  path: string
  opened: OpenedPptx
  dirty: boolean
  lastTouchedAt: number
}

const sessions = new Map<string, SlidesSessionInfo>()

function touch(info: SlidesSessionInfo): void {
  info.lastTouchedAt = Date.now()
}

function evictIfNeeded(): void {
  if (sessions.size <= MAX_SLIDES_SESSIONS) return
  let oldestPath: string | null = null
  let oldestTime = Number.POSITIVE_INFINITY
  for (const [p, info] of sessions) {
    if (info.lastTouchedAt < oldestTime) {
      oldestTime = info.lastTouchedAt
      oldestPath = p
    }
  }
  if (oldestPath) sessions.delete(oldestPath)
}

/** Register an opened deck keyed by path. Subsequent `slides:save` /
 *  `slides:apply-txn` look it up by the same path. */
export function registerSlidesSession(path: string, opened: OpenedPptx): void {
  sessions.set(path, {
    path,
    opened,
    dirty: false,
    lastTouchedAt: Date.now(),
  })
  evictIfNeeded()
}

export function getSlidesSession(path: string): SlidesSessionInfo | undefined {
  const info = sessions.get(path)
  if (info) touch(info)
  return info
}

/** Drop a session. Called on explicit close; LRU eviction is the other path. */
export function forgetSlidesSession(path: string): void {
  sessions.delete(path)
}

export function setSlidesDirty(path: string, dirty: boolean): void {
  const info = sessions.get(path)
  if (info) {
    info.dirty = dirty
    touch(info)
  }
}

export function getSlidesDirty(path: string): boolean {
  return Boolean(sessions.get(path)?.dirty)
}

/** Replace the model in place — used after a successful save (the on-disk
 *  bytes match the in-memory model again, but the renderer may have
 *  generated a fresh OpenedPptx on the next open). */
export function replaceSlidesSession(path: string, opened: OpenedPptx): void {
  sessions.set(path, {
    path,
    opened,
    dirty: false,
    lastTouchedAt: Date.now(),
  })
  evictIfNeeded()
}

/** Re-export so `slides:save` can serialise without re-importing. */
export { openPptx, savePptx }

export function registerSlidesStateHandlers(): void {
  registerHandle('slides:get-render-slides', () => [])
  registerHandle('slides:get-animations', () => [])
  registerHandle('slides:get-chart-data', () => ({}))
  registerHandle('slides:get-comments', () => [])
  registerHandle('slides:get-header-footer', () => ({ enabled: false }))
  registerHandle('slides:get-layouts', () => [])
  registerHandle('slides:get-link', () => null)
  registerHandle('slides:get-notes', () => '')
  registerHandle('slides:get-sections', () => [])
  registerHandle('slides:get-shape-keys', () => [])
  registerHandle('slides:get-slide-links', () => [])
  registerHandle('slides:get-slide-size', () => ({ width: 960, height: 540 }))
  registerHandle('slides:get-run-links', () => [])
  registerHandle('slides:has-slide-clipboard', () => false)
  registerHandle('slides:font-catalog', () => [])
  registerHandle('slides:font-missing', () => [])
  registerHandle('slides:chart-color-schemes', () => [])
  registerHandle('slides:clipboard-external', () => ({}))
  registerHandle('slides:clipboard-probe', () => ({}))
  registerHandle('slides:media-data', () => ({}))
  registerHandle('slides:native-clipboard', () => ({}))
  registerHandle('slides:table-structure', () => ({}))
  registerHandle('slides:private-font-data', () => ({}))
  registerHandle('slides:private-font-faces', () => [])
  registerHandle('slides:cloud-gen-status', () => ({ status: 'idle' }))

  // Real dirty-tracking: lookup by the path the renderer holds. Returns
  // false for unknown paths so a renderer that lost track of its session
  // (server restart, eviction) falls back to a no-op autosave rather than
  // a crash. The desktop equivalent lives in `apps/slides/src/main/slides-main.ts`
  // on the per-session `dirty` flag; the web build keeps it on the registry.
  registerHandle('slides:is-dirty', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string') return false
    // Resolve storage:// URIs the same way slides:open-path does so the
    // dirty bit lines up with the canonical key the registry stores.
    const key = storageKeyFromPath(path)
    const canonical = key ? join(FILES_DIR, key) : path
    return getSlidesDirty(canonical)
  })
}
