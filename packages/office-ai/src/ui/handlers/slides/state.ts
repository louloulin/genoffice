/**
 * Slides read-only query channels — get-render-slides, get-animations,
 * get-chart-data, get-comments, get-header-footer, get-layouts, etc.
 *
 * Plus the in-memory session registry that backs the real `slides:apply-txn`
 * and `slides:save` implementations. Without this registry the edit pipeline
 * has nowhere to keep the `OpenedPptx` between ops and a save, so every
 * edit answered `{ ok: true }` while losing the bytes.
 *
 * Port of `apps/web-server/src/slides/state.ts`. Two structural differences
 * from the original, both because office-ai hosts are per-instance:
 *  - the session registry / clipboard / SSE-path bindings live on a
 *    `SlidesState` created by `createSlidesState()` rather than in module
 *    globals, so two hosts in one process can't see each other's decks;
 *  - `FILES_DIR` + `storage://` keys are gone — a path is either inside the
 *    host workspace (resolved by the caller) or not a path at all.
 *
 * Concurrency: sessions are keyed by absolute path (the value the renderer
 * hands back to every `slides:*` channel). A long-running server with many
 * open tabs would otherwise hold every `OpenedPptx` resident forever; the
 * registry caps at 32 sessions and evicts the oldest.
 */
import {
  elementSpid,
  getChartElementData,
  getRunLinks,
  getSections,
  getSlideAnimations,
  getSlideComments,
  getSlideHidden,
  getSlideLinks,
  getSlideNotes,
  listEmbeddedFonts,
  listSlideLayouts,
  notesPathForSlide,
  parseTheme,
  readHeaderFooter,
  type ElementClipboardItem,
  type EmbeddedFontFace,
  type LinkTarget,
  type OpenedPptx,
  type SectionInfo,
  type Slide,
  type SlideAnimation,
  type SlideComment,
  type SlideDeck,
  type SlideLayoutInfo,
} from '@genoffice/pptx-engine'
import type { Registry } from '../../registry'

/** Office "colorful" fallback (matches desktop's FALLBACK_ACCENTS). Used when
 *  the deck has no theme or parseTheme throws — six accent hues that look
 *  sensible on a fresh blank.pptx. */
const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/** OFL font catalog projection for the renderer. The desktop `font-catalog.ts`
 *  generator also carries per-file sha256 + bytes for download verification;
 *  the renderer's wire contract only needs family + script + install state, so
 *  we project to just those two. Mirrored from
 *  `apps/slides/src/main/font-catalog.ts:15`. Adding a family here is a one-line
 *  edit; if the same family ships on desktop later it should land there too. */
interface FontCatalogEntry {
  family: string
  script: 'latin' | 'ja' | 'ko' | 'sc' | 'tc'
}
const FONT_CATALOG_DATA: ReadonlyArray<FontCatalogEntry> = [
  { family: 'Open Sans', script: 'latin' },
  { family: 'Roboto', script: 'latin' },
  { family: 'Lato', script: 'latin' },
  { family: 'Montserrat', script: 'latin' },
  { family: 'Poppins', script: 'latin' },
  { family: 'Inter', script: 'latin' },
  { family: 'Source Sans 3', script: 'latin' },
  { family: 'Oswald', script: 'latin' },
  { family: 'Raleway', script: 'latin' },
  { family: 'Nunito', script: 'latin' },
  { family: 'Merriweather', script: 'latin' },
  { family: 'Playfair Display', script: 'latin' },
  { family: 'Work Sans', script: 'latin' },
  { family: 'Rubik', script: 'latin' },
  { family: 'Noto Sans JP', script: 'ja' },
  { family: 'Noto Sans KR', script: 'ko' },
  { family: 'Noto Sans SC', script: 'sc' },
  { family: 'Noto Sans TC', script: 'tc' },
  { family: 'Nanum Gothic', script: 'ko' },
]

/** Text-shape shared by every text-bearing element (textbox, table cell, etc.).
 *  `collectRuns` only reads `.paragraphs[].runs[].fontFamily` — the field that
 *  records what PowerPoint would draw the run with, after theme inheritance. */
interface TextLike {
  paragraphs?: Array<{ runs?: Array<{ fontFamily?: string }> }>
}

/** Mix a hex color (#RRGGBB) toward an 8-bit target by `ratio`. Ratio 0
 *  returns the original; ratio 1 returns the target. Used to build the
 *  5-step mono gradient per accent. */
function mixHex(hex: string, target: number, ratio: number): string {
  const v = parseInt(hex.replace('#', ''), 16)
  if (!Number.isFinite(v)) return hex
  const ch = (x: number): number => Math.round(x + (target - x) * ratio)
  const r = ch((v >> 16) & 255)
  const g = ch((v >> 8) & 255)
  const b = ch(v & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0').toUpperCase()}`
}

/** Read the deck's theme accent1..6 from the first slide's inheritance
 *  chain. Returns FALLBACK_ACCENTS when the deck has no theme or parseTheme
 *  throws — the renderer's chart palette dialog must always have *some*
 *  six colors to pick from. */
function deckAccents(opened: OpenedPptx): string[] {
  const slide = opened.deck.slides[0]
  if (!slide) return FALLBACK_ACCENTS
  try {
    const chain = opened.archive.resolveSlideChain(slide.path)
    const xml = chain.themePath ? opened.archive.readText(chain.themePath) : null
    const colors = xml ? parseTheme(xml).colors : undefined
    const acc = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']
      .map((k) => colors?.[k])
      .filter((c): c is string => !!c)
    return acc.length >= 3 ? acc : FALLBACK_ACCENTS
  } catch {
    return FALLBACK_ACCENTS
  }
}

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
  /**
   * Master-view edit target: the part being edited + its parsed slide. Held
   * across edits so parse-time element ids stay stable for the renderer's
   * selection / editing state — re-parsing on every master-edit call would
   * remint ids and break selection, the same defect §A.5 #7 closed for the
   * outer deck. Part-addressed ops (`target.part`) mutate `slide` in place;
   * the executor's `flushTouchedParts` re-serialises it to `archive.entries`
   * and then re-materialises every deck slide so the inheritance chain picks
   * up the chrome changes.
   */
  masterEdit?: { partPath: string; slide: Slide }
}

/** Whole-deck snapshot — mirrors the desktop `HistorySnapshot`. */
export interface SlidesHistorySnapshot {
  slides: Slide[]
  entries: Map<string, Uint8Array>
  size: { cx: number; cy: number }
}

/** Canvas width used when the renderer never supplied one. Matches the
 *  desktop default (`FIT_WIDTH = 1280` in apps/slides). */
export const DEFAULT_SLIDES_FIT_WIDTH = 1280

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

/** Cloning on restore matters: the live deck mutates element objects in place,
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

/** Push a pre-edit snapshot and drop the redo branch (a new edit invalidates it).
 *
 *  Returns the redo depth that was cleared, so a handler whose op the engine
 *  refuses can hand it back to `rollbackSlidesHistory` — an edit that never
 *  applied must not take the user's redo branch with it.
 *
 *  `event` is the invoking IPC event; when present, the renderer is told the
 *  new stack depths (see `notifySlidesHistory`). */
export function pushSlidesHistory(info: SlidesSessionInfo, event?: unknown): number {
  info.undoStack.push(takeSlidesSnapshot(info))
  trimHistory(info.undoStack)
  const redoDepth = info.redoStack.length
  info.redoStack = []
  if (event !== undefined) notifySlidesHistory(event, info)
  return redoDepth
}

/**
 * Undo the bookkeeping for an edit the engine refused: drop the pre-edit
 * snapshot (or Undo would restore a state the failure already left in place)
 * and restore the redo branch the snapshot's push cleared.
 */
export function rollbackSlidesHistory(
  info: SlidesSessionInfo,
  redoDepth: number,
  event?: unknown,
): void {
  info.undoStack.pop()
  info.redoStack.length = redoDepth
  if (event !== undefined) notifySlidesHistory(event, info)
}

/** Undo one step. Returns false when there is nothing to undo. */
export function undoSlidesHistory(info: SlidesSessionInfo, event?: unknown): boolean {
  settleStaleHistoryBatch(info)
  if (info.undoStack.length === 0) return false
  info.redoStack.push(takeSlidesSnapshot(info))
  restoreSlidesSnapshot(info, info.undoStack.pop()!)
  if (event !== undefined) notifySlidesHistory(event, info)
  return true
}

/** Redo one step. Returns false when there is nothing to redo. */
export function redoSlidesHistory(info: SlidesSessionInfo, event?: unknown): boolean {
  settleStaleHistoryBatch(info)
  if (info.redoStack.length === 0) return false
  info.undoStack.push(takeSlidesSnapshot(info))
  restoreSlidesSnapshot(info, info.redoStack.pop()!)
  if (event !== undefined) notifySlidesHistory(event, info)
  return true
}

/**
 * Push `slides:history-changed` so the renderer's Undo/Redo buttons reflect the
 * real stack depths.
 *
 * The renderer learns its undo state only from this event (`App.tsx` subscribes
 * once at mount and never asks again), so a host that never emits it leaves
 * those buttons greyed for the whole session even while edits commit — the
 * edits work, Undo silently does nothing.
 *
 * Deferred to the turn boundary: every mutation handler pushes a snapshot and
 * pops it again when the op fails, and a `slides:apply-txn` with several ops
 * would otherwise emit one message per op. Reading the stacks at flush time
 * reports the settled state, coalesced per SSE session.
 */
const pendingHistoryNotify = new Set<string>()

export function notifySlidesHistory(event: unknown, info: SlidesSessionInfo): void {
  const sessionId = (event as { sessionId?: string } | undefined)?.sessionId ?? ''
  if (pendingHistoryNotify.has(sessionId)) return
  pendingHistoryNotify.add(sessionId)
  setImmediate(() => {
    pendingHistoryNotify.delete(sessionId)
    sendIpcEvent(event, 'slides:history-changed', {
      canUndo: info.undoStack.length > 0,
      canRedo: info.redoStack.length > 0,
    })
  })
}

/** Send to the renderer's SSE stream for the session that made the call. */
function sendIpcEvent(event: unknown, channel: string, ...args: unknown[]): void {
  const sender = (
    event as { sender?: { send?: (channel: string, ...args: unknown[]) => void } } | undefined
  )?.sender
  sender?.send?.(channel, ...args)
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

/** Per-host session store. `createSlidesState()` builds one; `host.close()`
 *  drops it with everything else the host owns. */
export interface SlidesState {
  registerSession(path: string, opened: OpenedPptx, fitWidthPx?: number): void
  getSession(path: string): SlidesSessionInfo | undefined
  forgetSession(path: string): void
  replaceSession(path: string, opened: OpenedPptx): void
  setFitWidth(path: string, fitWidthPx: number): void
  getFitWidth(path: string): number
  setDirty(path: string, dirty: boolean): void
  isDirty(path: string): boolean
  setMasterEdit(path: string, edit: { partPath: string; slide: Slide } | undefined): void
  /** Bind the deck the SSE session is currently driving. */
  setCurrentPath(sessionId: string | undefined, path: string): void
  getCurrentPath(sessionId: string | undefined): string | undefined
  clearCurrentPath(sessionId: string | undefined, path: string): void
  /** Drop every session binding pointing at `path`, whichever SSE session held it. */
  forgetSessionForPath(path: string): void
  setElementClipboard(items: ElementClipboardItem[]): void
  getElementClipboard(): ElementClipboardItem[]
  dispose(): void
}

export function createSlidesState(): SlidesState {
  const sessions = new Map<string, SlidesSessionInfo>()
  /**
   * Per-SSE-session current slides path. The renderer can only have one deck
   * active at a time, so this maps the SSE session id (the value the renderer
   * sends as `x-ipc-session`) to the path it last opened via `slides:open-path`.
   * Legacy channels (`slides:save` / `slides:apply-txn` / `slides:edit-text`
   * etc.) look up the path through `getCurrentPath(event)` so the renderer
   * doesn't have to send it on every call.
   */
  const currentPathBySession = new Map<string, string>()
  /**
   * App-wide element clipboard. The renderer copies in one deck and pastes into
   * another, so this deliberately outlives any single session. `slides:copy-elements`
   * used to answer `{ok:true}` — the shape the renderer compares against a number
   * — while saving nothing, so Paste silently did nothing.
   */
  let elementClipboard: ElementClipboardItem[] = []

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

  return {
    registerSession(path, opened, fitWidthPx = DEFAULT_SLIDES_FIT_WIDTH) {
      sessions.set(path, {
        path,
        opened,
        dirty: false,
        lastTouchedAt: Date.now(),
        fitWidthPx:
          Number.isFinite(fitWidthPx) && fitWidthPx > 0 ? fitWidthPx : DEFAULT_SLIDES_FIT_WIDTH,
        undoStack: [],
        redoStack: [],
      })
      evictIfNeeded()
    },

    getSession(path) {
      const info = sessions.get(path)
      if (info) touch(info)
      return info
    },

    forgetSession(path) {
      sessions.delete(path)
    },

    /** Replace the model in place — used after a successful save (the on-disk
     *  bytes match the in-memory model again, but the renderer may have
     *  generated a fresh OpenedPptx on the next open). */
    replaceSession(path, opened) {
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
        // Drop masterEdit on replace — the slide model pointed at the OLD
        // archive's entries; reusing it after save would leave the new save
        // silent (op mutations land on a detached model). The renderer must
        // re-enter master view after a save to refresh, which matches desktop.
        ...(previous?.historyBatch ? { historyBatch: previous.historyBatch } : {}),
        ...(previous?.aiSnapshots ? { aiSnapshots: previous.aiSnapshots } : {}),
      })
      evictIfNeeded()
    },

    setFitWidth(path, fitWidthPx) {
      const info = sessions.get(path)
      if (info && Number.isFinite(fitWidthPx) && fitWidthPx > 0) {
        info.fitWidthPx = fitWidthPx
        touch(info)
      }
    },

    getFitWidth(path) {
      return sessions.get(path)?.fitWidthPx ?? DEFAULT_SLIDES_FIT_WIDTH
    },

    setDirty(path, dirty) {
      const info = sessions.get(path)
      if (info) {
        info.dirty = dirty
        touch(info)
      }
    },

    isDirty(path) {
      return Boolean(sessions.get(path)?.dirty)
    },

    /** Bind the master-view edit target on the session. The same part object is
     *  reused across edits so element ids stay stable; `master-open` and
     *  `master-enter` both go through this so a re-open always re-parses from
     *  disk (in case the renderer re-mounted after a save). */
    setMasterEdit(path, edit) {
      const info = sessions.get(path)
      if (!info) return
      if (edit) info.masterEdit = edit
      else delete info.masterEdit
      touch(info)
    },

    setCurrentPath(sessionId, path) {
      if (!sessionId) return
      currentPathBySession.set(sessionId, path)
    },

    getCurrentPath(sessionId) {
      if (!sessionId) return undefined
      return currentPathBySession.get(sessionId)
    },

    clearCurrentPath(sessionId, path) {
      if (!sessionId) return
      if (currentPathBySession.get(sessionId) === path) currentPathBySession.delete(sessionId)
    },

    forgetSessionForPath(path) {
      for (const [sid, p] of currentPathBySession) {
        if (p === path) currentPathBySession.delete(sid)
      }
    },

    setElementClipboard(items) {
      elementClipboard = items
    },

    getElementClipboard() {
      return elementClipboard
    },

    dispose() {
      sessions.clear()
      currentPathBySession.clear()
      elementClipboard = []
    },
  }
}

/**
 * Resolve the live read-model behind a get-* channel.
 *
 * Every read-only `slides:get-*` channel needs the same three things:
 *  (a) the SSE session id (so we can find the path),
 *  (b) the `SlidesSessionInfo` registered for that path,
 *  (c) the live `OpenedPptx` (apply-txn mutates it in-place, so the
 *      read model has to come from `session.opened.deck` rather than
 *      a fresh `openPptx` — see sdk1 §11.42.3 about engine-side id
 *      instability).
 *
 * Returns `null` for unknown paths so a renderer that hasn't called
 * `slides:open-path` yet (or whose SSE session was evicted) gets the
 * legacy fallback shape (empty array / default slide size / empty
 * string) instead of a crash.
 */
export function resolveSlidesReadModel(
  state: SlidesState,
  event: unknown,
): { session: SlidesSessionInfo; opened: OpenedPptx; deck: SlideDeck } | null {
  const sessionId = (event as { sessionId?: string } | null)?.sessionId
  const path = state.getCurrentPath(sessionId)
  if (!path) return null
  const session = state.getSession(path)
  if (!session?.opened) return null
  return { session, opened: session.opened, deck: session.opened.deck }
}

/**
 * The pptx-engine hyperlink helpers return `{ elementId, target }` for
 * each link found on a slide; the renderer contract expects
 * `{ sourceId, target }` instead. The fields hold the same value, so a
 * one-line rename per item is enough. Empty arrays stay empty so the
 * `for (const link of links)` loop the renderer runs on the result never
 * sees undefined.
 */
function projectSlideLinks(
  links: ReadonlyArray<{ elementId: string; target: LinkTarget }>,
): Array<{ sourceId: string; target: LinkTarget }> {
  const out: Array<{ sourceId: string; target: LinkTarget }> = []
  for (const l of links) out.push({ sourceId: l.elementId, target: l.target })
  return out
}

function projectRunLinks(
  links: ReadonlyArray<{
    elementId: string
    paraIndex: number
    runIndex: number
    target: LinkTarget
  }>,
): Array<{ sourceId: string; paraIndex: number; runIndex: number; target: LinkTarget }> {
  const out: Array<{ sourceId: string; paraIndex: number; runIndex: number; target: LinkTarget }> = []
  for (const l of links) {
    out.push({
      sourceId: l.elementId,
      paraIndex: l.paraIndex,
      runIndex: l.runIndex,
      target: l.target,
    })
  }
  return out
}

/** EMU per CSS pixel at 96 DPI; pptx-engine stores dimensions in EMU. */
const EMU_PER_PX = 9525

/**
 * Project a slide down to the small shape the renderer needs for the
 * slide-strip / thumbnails. PowerPoint carries no canonical id we can
 * trust across re-parse, so we use the array index. `hidden` is included so
 * the strip can grey out hidden slides.
 */
function projectRenderSlide(slide: Slide, archive: OpenedPptx['archive'], index: number): {
  index: number
  hidden: boolean
  hasNotes: boolean
  name: string
} {
  // Slide's authoritative `name` is `p:cSld@name` in the slide XML; the
  // engine keeps that prefix in `slide.bodyPrefix`. We regex-extract
  // rather than adding a getter so the projection stays allocation-free
  // for the slide-strip render. Falls back to "Slide N" when the deck
  // has no per-slide name (the common case).
  const nameMatch = /<p:cSld[^>]*\bname="([^"]*)"/.exec(slide.bodyPrefix)
  const name = nameMatch?.[1] || `Slide ${index + 1}`
  return {
    index,
    hidden: getSlideHidden(slide),
    hasNotes: notesPathForSlide(archive, slide.path) != null,
    name,
  }
}

export function registerSlidesStateHandlers(registry: Registry, state: SlidesState): void {
  // Real render-slides: project each slide to the small shape the
  // renderer's slide-strip / thumbnails need. Returns [] when no
  // session is bound so the strip stays empty rather than throwing.
  registry.registerHandle('slides:get-render-slides', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return []
    return rm.deck.slides.map((s, i) => projectRenderSlide(s, rm.opened.archive, i))
  })
  // Real animations: read the live `<p:timing>` projection from the
  // slide's bodySuffix. The engine keeps the animation list in sync
  // with apply-txn's setAnimations op so live edits show up here.
  registry.registerHandle('slides:get-animations', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return [] as SlideAnimation[]
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return [] as SlideAnimation[]
    return getSlideAnimations(slide)
  })
  // Real chart data: engine's getChartElementData returns the dialog
  // echo shape verbatim. Returns null when no session is bound,
  // slideIndex is out of range, sourceId is not a string, or the element
  // is not a chart — matches the renderer's `if (r)` guard.
  registry.registerHandle('slides:get-chart-data', (event: unknown, slideIndex: unknown, sourceId: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number' || typeof sourceId !== 'string') return null
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return null
    return getChartElementData(slide, sourceId)
  })
  // Real comments: read the live commentsSlide part. Malformed commentsSlide
  // XML (rare but happens with hand-edited pptx) — fail soft.
  registry.registerHandle('slides:get-comments', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return [] as SlideComment[]
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return [] as SlideComment[]
    try {
      return getSlideComments(rm.opened.archive, slide.path)
    } catch {
      return [] as SlideComment[]
    }
  })
  // Real header/footer echo for the dialog: read the live slide's
  // placeholder state so the answer reflects the post-applyHeaderFooter
  // state without a re-parse. Unbound/out-of-range returns
  // `{ enabled: false }` so the dialog paints a disabled footer.
  registry.registerHandle('slides:get-header-footer', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return { enabled: false as const }
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return { enabled: false as const }
    const hf = readHeaderFooter(slide)
    return {
      enabled: hf.footer != null || hf.date != null || hf.slideNum,
      footer: hf.footer,
      slideNum: hf.slideNum,
      date: hf.date,
    }
  })
  // Real layouts: enumerate every slideLayout. The engine's SlideLayoutInfo
  // shape is identical to what the renderer's GetLayoutsResult expects under
  // the `layouts` key. Unknown session: `{ layouts: [] }`.
  registry.registerHandle('slides:get-layouts', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return { layouts: [] as SlideLayoutInfo[] }
    return { layouts: listSlideLayouts(rm.opened.archive) }
  })
  // Single-element link lookup: filter the slide-links projection by
  // sourceId (= elementId). Returns null when the element has no link.
  registry.registerHandle('slides:get-link', (event: unknown, slideIndex: unknown, sourceId: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number' || typeof sourceId !== 'string') return null
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return null
    const links = getSlideLinks(rm.opened, slideIndex)
    const found = links.find((l) => l.elementId === sourceId)
    return found ? found.target : null
  })
  // Real notes: read the live notesSlide archive part (apply-txn with
  // setSlideNotes mutates the same archive). Unknown session/out-of-range
  // returns '' — the shape the renderer already tolerates.
  registry.registerHandle('slides:get-notes', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return ''
    if (typeof slideIndex !== 'number' || slideIndex < 0) return ''
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return ''
    try {
      return getSlideNotes(rm.opened.archive, slide.path)
    } catch {
      return ''
    }
  })
  // Real sections: read presentation.xml's p14:sectionLst. The engine is the
  // authoritative parser, so sldIds referencing deleted slides are already
  // filtered. Unknown session: [].
  registry.registerHandle('slides:get-sections', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return [] as SectionInfo[]
    return getSections(rm.opened)
  })
  // Engine has no morph-key model yet. Return [] honestly so the renderer
  // doesn't see undefined.
  //
  // Real get-shape-keys: cNvPr id (`spid`) and `name` are stable across
  // reparses; `el.id` (= sourceId) is not. The stub used to return [] which
  // made Morph silently no-op.
  registry.registerHandle('slides:get-shape-keys', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return []
    const slide = rm.opened.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }))
  })
  // Real slide-level links: walk every element (groups recursed) and resolve
  // any `a:hlinkClick` against the slide's rels, which live in the live archive.
  registry.registerHandle('slides:get-slide-links', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return []
    return projectSlideLinks(getSlideLinks(rm.opened, slideIndex))
  })
  // Real slide-size: project the deck's EMU dimensions onto CSS pixels at
  // 96 DPI. The previous hardcoded 960x540 was wrong for any 4:3 / a4 /
  // custom-size deck.
  registry.registerHandle('slides:get-slide-size', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return { width: 960, height: 540 }
    const { cx, cy } = rm.deck.size
    return { width: Math.round(cx / EMU_PER_PX), height: Math.round(cy / EMU_PER_PX) }
  })
  // Real run-level links: one entry per text run whose TextRun.hyperlinkRId
  // resolves to a url/slide target via the live rels.
  registry.registerHandle('slides:get-run-links', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number') return []
    return projectRunLinks(getRunLinks(rm.opened, slideIndex))
  })
  // Real has-slide-clipboard: the engine element clipboard outlives any
  // single session, so this reports whether anything is sitting in it and the
  // Paste menu item can grey itself out.
  registry.registerHandle('slides:has-slide-clipboard', () => {
    return state.getElementClipboard().length > 0
  })
  // Real font-catalog: the OFL catalog is a generated data table (sha256 +
  // bytes per file); the renderer's contract is just
  // `Array<{ family, script, installed, downloading }>`, so we project to
  // family + script. The library can't track local install state (that lives
  // in the browser's FontFace store), so we report false for every family —
  // the renderer falls back to whatever it has locally for layout.
  registry.registerHandle('slides:font-catalog', () => {
    return FONT_CATALOG_DATA.map((f) => ({
      family: f.family,
      script: f.script,
      installed: false,
      downloading: false,
    }))
  })
  // Real font-missing: walks every element on every slide, collects the
  // fontFamily off each text run, and returns those that are in the catalog.
  registry.registerHandle('slides:font-missing', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return []
    const wanted = new Set<string>()
    const collectRuns = (text: TextLike | undefined): void => {
      for (const p of text?.paragraphs ?? [])
        for (const r of p.runs ?? []) if (r.fontFamily) wanted.add(r.fontFamily)
    }
    const walk = (els: ReadonlyArray<unknown>): void => {
      for (const el of els) {
        if (!el || typeof el !== 'object') continue
        const e = el as {
          children?: unknown[]
          text?: TextLike
          rows?: Array<Array<{ text?: TextLike }>>
        }
        if (e.children) walk(e.children as ReadonlyArray<unknown>)
        collectRuns(e.text)
        for (const row of e.rows ?? []) for (const cell of row) collectRuns(cell.text)
      }
    }
    for (const s of rm.opened.deck.slides) walk(s.elements as unknown[])
    const inCatalog = new Set(FONT_CATALOG_DATA.map((f) => f.family))
    return [...wanted].filter((f) => inCatalog.has(f)).sort()
  })
  // Real chart-color-schemes: reads the live deck's theme accent1..6 and
  // projects to `Array<{ key, label, colors }>`:
  //   - 'default' is empty colors (keep the chart's existing palette)
  //   - 'colorful' / 'colorful2' rotate the 6 accents
  //   - 'mono-accentN' is a 5-step gradient per accent
  registry.registerHandle('slides:chart-color-schemes', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return null
    const acc = deckAccents(rm.opened)
    const rot = [...acc.slice(3), ...acc.slice(0, 3)]
    const mono = (c: string): string[] => [
      mixHex(c, 0, 0.25),
      c,
      mixHex(c, 255, 0.25),
      mixHex(c, 255, 0.45),
      mixHex(c, 255, 0.65),
    ]
    return [
      { key: 'default', label: 'Theme default', colors: [] },
      { key: 'colorful', label: 'Colorful', colors: acc },
      { key: 'colorful2', label: 'Colorful 2', colors: rot },
      ...acc.map((c, i) => ({
        key: `mono-accent${i + 1}`,
        label: `Monochromatic accent ${i + 1}`,
        colors: mono(c),
      })),
    ]
  })
  // Honest ack-only: these three are OS-native clipboard write/read probes.
  // The library has no clipboard so an implementation would be theatre; the
  // renderer's web-bridge resolves them locally (browser Clipboard API).
  // Returning `{}` confused App.tsx — `clipboardProbe().then(setHasClipboard)`
  // made `hasClipboard` flip true and Paste stayed enabled on an empty
  // clipboard. The fixed shape matches the renderer's own contract.
  registry.registerHandle('slides:clipboard-probe', () => false)
  registry.registerHandle('slides:clipboard-external', () => null)
  registry.registerHandle('slides:native-clipboard', () => null)
  // Real media-data: the renderer double-clicks a video/audio element and asks
  // for the bytes so the <video>/<audio> tag can mount. Read from the in-memory
  // `opened.archive` — the same archive the open-path / apply-txn pipeline
  // materializes, so no extra parse. External links are returned verbatim;
  // embedded media becomes a `data:` URL.
  const AV_MIME: Record<string, string> = {
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    // Chromium refuses to load video/quicktime but demuxes QuickTime bytes
    // through ISO-BMFF when served as video/mp4 — keep desktop parity.
    mov: 'video/mp4',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
  }
  registry.registerHandle('slides:media-data', (event: unknown, slideIndex: unknown, sourceId: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof slideIndex !== 'number' || typeof sourceId !== 'string') return null
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return null
    const el = slide.elements.find((x: { id: string }) => x.id === sourceId)
    if (!el || (el as { type?: string }).type !== 'picture') return null
    const media = (el as {
      media?: { kind: 'video' | 'audio'; target?: string; external?: boolean }
    }).media
    if (!media?.target) return null
    if (media.external) return { kind: media.kind, dataUrl: media.target }
    const bytes = rm.opened.archive.readBytes(media.target)
    if (!bytes) return null
    const ext = media.target.split('.').pop()?.toLowerCase() ?? ''
    const mime = AV_MIME[ext] ?? (media.kind === 'video' ? 'video/mp4' : 'audio/mpeg')
    return {
      kind: media.kind,
      dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
    }
  })
  // Real private-font-data: the renderer pulls one face's sfnt bytes by index.
  // Each face is typically 100-300 KB so we never broadcast the whole list.
  registry.registerHandle('slides:private-font-data', (event: unknown, id: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm || typeof id !== 'number' || id < 0) return null
    const faces = listEmbeddedFonts(rm.opened.archive)
    const face = faces[id]
    if (!face) return null
    return { data: face.sfnt, typeface: face.typeface, style: face.style }
  })
  // Real private-font-faces: walk presentation.xml's p:embeddedFontLst. The
  // sfnt bytes are intentionally NOT shipped over IPC (a single face can be
  // 100+ KB and the renderer fetches its own bytes via slides:private-font-data
  // only when it needs to render).
  registry.registerHandle('slides:private-font-faces', (event: unknown) => {
    const rm = resolveSlidesReadModel(state, event)
    if (!rm) return [] as Array<Pick<EmbeddedFontFace, 'typeface' | 'style'>>
    return listEmbeddedFonts(rm.opened.archive).map((f) => ({
      typeface: f.typeface,
      style: f.style,
    }))
  })
  // cloud-gen-status stays idle: the actual cloud-generation flow needs an
  // image provider, asset upload and polling that a library does not have. The
  // renderer falls back to local-only generation, so idle is the honest
  // "not implemented here" shape rather than a fake-progress object.
  registry.registerHandle('slides:cloud-gen-status', () => ({ status: 'idle' as const }))

  // Real dirty-tracking: lookup by the path the renderer holds. Returns false
  // for unknown paths so a renderer that lost track of its session falls back
  // to a no-op autosave rather than a crash.
  registry.registerHandle('slides:is-dirty', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string') return false
    return state.isDirty(path)
  })
}
