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
import {
  openPptx,
  savePptx,
  type ElementClipboardItem,
  type OpenedPptx,
  type Slide,
} from '@genoffice/pptx-engine'

const MAX_SLIDES_SESSIONS = 32

export interface SlidesSessionInfo {
  path: string
  opened: OpenedPptx
  dirty: boolean
  lastTouchedAt: number
  /**
   * Canvas width the renderer last asked for. The desktop session keeps the
   * same field because the slide lifecycle channels return re-rendered slides
   * and have to reuse whatever width the open used — rendering at a different
   * width would make every slide jump on the next insert.
   */
  fitWidthPx: number
  /**
   * Undo / redo stacks. The desktop session keeps the same pair; without them
   * `slides:undo` had nothing to restore and answered `{ok:true}`, so the
   * renderer's Undo button appeared to work while the deck never changed.
   * Snapshots are whole-deck copies (slides + archive entries + deck size),
   * exactly like `takeSnapshot` in apps/slides/src/main/session-state.ts.
   */
  undoStack: SlidesHistorySnapshot[]
  redoStack: SlidesHistorySnapshot[]
  /** Pre-batch snapshot while a history batch is open (AI runs collapse many
   *  edits into one undo step). Nested begins increment `depth`. */
  historyBatch?: {
    depth: number
    undoStart: number
    before: SlidesHistorySnapshot
  }
  /** Rollback points the AI panel lists, keyed by id. */
  aiSnapshots?: Map<number, SlidesHistorySnapshot>
}

/** Whole-deck snapshot — mirrors the desktop `HistorySnapshot`. */
export interface SlidesHistorySnapshot {
  slides: Slide[]
  entries: Map<string, Uint8Array>
  size: { cx: number; cy: number }
}

/** Caps match the desktop (`MAX_HISTORY = 50`). */
const MAX_HISTORY = 50

function trimHistory(stack: SlidesHistorySnapshot[]): void {
  while (stack.length > MAX_HISTORY) stack.shift()
}

export function takeSlidesSnapshot(info: SlidesSessionInfo): SlidesHistorySnapshot {
  return {
    slides: structuredClone(info.opened.deck.slides),
    entries: new Map(info.opened.archive.entries),
    size: { ...info.opened.deck.size },
  }
}

/* Cloning on restore matters: the live deck mutates element objects in place,
 * so handing a snapshot's own arrays over would let a later edit rewrite
 * history the other stack still references — undo → edit → redo would replay
 * mutated state. The desktop `restoreSnapshot` clones for the same reason. */
function restoreSlidesSnapshot(info: SlidesSessionInfo, snap: SlidesHistorySnapshot): void {
  info.opened.deck.slides = structuredClone(snap.slides)
  info.opened.deck.size = { ...snap.size }
  const entries = info.opened.archive.entries
  entries.clear()
  for (const [k, v] of snap.entries) entries.set(k, v)
}

/** Push a pre-edit snapshot and drop the redo branch (a new edit invalidates it). */
export function pushSlidesHistory(info: SlidesSessionInfo): void {
  info.undoStack.push(takeSlidesSnapshot(info))
  trimHistory(info.undoStack)
  info.redoStack = []
}

/** Undo one step. Returns false when there is nothing to undo. */
export function undoSlidesHistory(info: SlidesSessionInfo): boolean {
  settleStaleHistoryBatch(info)
  if (info.undoStack.length === 0) return false
  info.redoStack.push(takeSlidesSnapshot(info))
  restoreSlidesSnapshot(info, info.undoStack.pop()!)
  return true
}

/** Redo one step. Returns false when there is nothing to redo. */
export function redoSlidesHistory(info: SlidesSessionInfo): boolean {
  settleStaleHistoryBatch(info)
  if (info.redoStack.length === 0) return false
  info.undoStack.push(takeSlidesSnapshot(info))
  restoreSlidesSnapshot(info, info.redoStack.pop()!)
  return true
}

export function beginSlidesHistoryBatch(info: SlidesSessionInfo): void {
  if (info.historyBatch) {
    info.historyBatch.depth += 1
    return
  }
  info.historyBatch = {
    depth: 1,
    undoStart: info.undoStack.length,
    before: takeSlidesSnapshot(info),
  }
}

/**
 * Close a history batch, collapsing every successful edit since `begin` into
 * the pre-batch snapshot. Returns the snapshot so the caller can register it as
 * an AI rollback point — or null when the batch collapsed no real edit.
 */
export function endSlidesHistoryBatch(info: SlidesSessionInfo): SlidesHistorySnapshot | null {
  const batch = info.historyBatch
  if (!batch) return null
  batch.depth -= 1
  if (batch.depth > 0) return null
  info.historyBatch = undefined
  // Drop the per-edit snapshots the batch subsumes; the batch's own `before`
  // becomes the single undo step for the whole run.
  info.undoStack.length = Math.min(info.undoStack.length, batch.undoStart)
  info.undoStack.push(batch.before)
  trimHistory(info.undoStack)
  info.redoStack = []
  return batch.before
}

/** A batch that outlived its run must not swallow later edits — settle it. */
function settleStaleHistoryBatch(info: SlidesSessionInfo): void {
  if (info.historyBatch) endSlidesHistoryBatch(info)
}

export function registerSlidesAiSnapshot(
  info: SlidesSessionInfo,
  snap: SlidesHistorySnapshot,
): number {
  const map = (info.aiSnapshots ??= new Map())
  const id = map.size + 1
  map.set(id, snap)
  return id
}

export function restoreSlidesAiSnapshot(info: SlidesSessionInfo, id: number): boolean {
  const snap = info.aiSnapshots?.get(id)
  if (!snap) return false
  info.redoStack.push(takeSlidesSnapshot(info))
  restoreSlidesSnapshot(info, snap)
  return true
}

const sessions = new Map<string, SlidesSessionInfo>()

/**
 * Per-SSE-session current slides path. The renderer can only have one deck
 * active at a time, so this maps the SSE session id (the value the renderer
 * sends as `x-ipc-session`) to the path it last opened via `slides:open-path`.
 * Legacy channels (`slides:save` / `slides:apply-txn` / `slides:edit-text`
 * etc.) look up the path through `getCurrentSlidesPath(event)` so the
 * renderer doesn't have to send it on every call.
 *
 * Cleared when `slides:close` or `forgetSlidesSessionForPath` runs.
 */
const currentSlidesPathBySession = new Map<string, string>()

/**
 * App-wide element clipboard. The renderer copies in one deck and pastes into
 * another, so this deliberately outlives any single session (the desktop keeps
 * it on the app, not the window). `slides:copy-elements` used to answer
 * `{ok:true}` — the shape the renderer compares against a number — while saving
 * nothing, so Paste silently did nothing.
 */
let slidesElementClipboard: ElementClipboardItem[] = []

export function setSlidesElementClipboard(items: ElementClipboardItem[]): void {
  slidesElementClipboard = items
}

export function getSlidesElementClipboard(): ElementClipboardItem[] {
  return slidesElementClipboard
}

export function setCurrentSlidesPath(sessionId: string | undefined, path: string): void {
  if (!sessionId) return
  currentSlidesPathBySession.set(sessionId, path)
}

export function getCurrentSlidesPath(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined
  return currentSlidesPathBySession.get(sessionId)
}

export function clearCurrentSlidesPath(sessionId: string | undefined, path: string): void {
  if (!sessionId) return
  const cur = currentSlidesPathBySession.get(sessionId)
  if (cur === path) currentSlidesPathBySession.delete(sessionId)
}

/** Drop the sessionPath binding on a path regardless of which session held it.
 *  Used when `forgetSlidesSession` is called so a stale binding can't survive
 *  a registry eviction. */
export function forgetSlidesSessionForPath(path: string): void {
  for (const [sid, p] of currentSlidesPathBySession) {
    if (p === path) currentSlidesPathBySession.delete(sid)
  }
}

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
/** Canvas width used when the renderer never supplied one. Matches the
 *  desktop default (`FIT_WIDTH = 1280` in apps/slides). */
export const DEFAULT_SLIDES_FIT_WIDTH = 1280

export function registerSlidesSession(
  path: string,
  opened: OpenedPptx,
  fitWidthPx: number = DEFAULT_SLIDES_FIT_WIDTH,
): void {
  sessions.set(path, {
    path,
    opened,
    dirty: false,
    lastTouchedAt: Date.now(),
    fitWidthPx: Number.isFinite(fitWidthPx) && fitWidthPx > 0 ? fitWidthPx : DEFAULT_SLIDES_FIT_WIDTH,
    undoStack: [],
    redoStack: [],
  })
  evictIfNeeded()
}

/** Update the canvas width for a live session (the renderer re-fits on zoom). */
export function setSlidesFitWidth(path: string, fitWidthPx: number): void {
  const info = sessions.get(path)
  if (info && Number.isFinite(fitWidthPx) && fitWidthPx > 0) {
    info.fitWidthPx = fitWidthPx
    touch(info)
  }
}

/** Canvas width the session was last rendered at. */
export function getSlidesFitWidth(path: string): number {
  return sessions.get(path)?.fitWidthPx ?? DEFAULT_SLIDES_FIT_WIDTH
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
  const previous = sessions.get(path)
  /* A save does not invalidate history: the user can still undo past it, and
   * the desktop keeps its stacks across a save for the same reason. */
  sessions.set(path, {
    path,
    opened,
    dirty: false,
    lastTouchedAt: Date.now(),
    fitWidthPx: previous?.fitWidthPx ?? DEFAULT_SLIDES_FIT_WIDTH,
    undoStack: previous?.undoStack ?? [],
    redoStack: previous?.redoStack ?? [],
    ...(previous?.historyBatch ? { historyBatch: previous.historyBatch } : {}),
    ...(previous?.aiSnapshots ? { aiSnapshots: previous.aiSnapshots } : {}),
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
