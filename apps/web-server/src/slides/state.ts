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
  openPptx,
  readHeaderFooter,
  savePptx,
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
  parseTheme,
} from '@genoffice/pptx-engine'

/** Office "colorful" fallback (matches desktop's FALLBACK_ACCENTS). Used when
 *  the deck has no theme or parseTheme throws — six accent hues that look
 *  sensible on a fresh blank.pptx. */
const FALLBACK_ACCENTS = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47']

/** OFL font catalog projection for the renderer. The desktop `font-catalog.ts`
 *  generator also carries per-file sha256 + bytes for download verification;
 *  the renderer's wire contract only needs family + script + install state, so
 *  we project to just those two. Mirrored from
 *  `apps/slides/src/main/font-catalog.ts:15`. Adding a family here is a one-line
 *  edit; if the same family ships on desktop later it should land there too.
 *  (sdk1 §11.53 / §A.5 backlog closure). */
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
 *  `walk` only reads `.paragraphs[].runs[].fontFamily` — the field that
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
 *  chain (mirrors `deckAccents` in apps/slides/src/main/slides-main.ts:983).
 *  Returns FALLBACK_ACCENTS when the deck has no theme or parseTheme
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
function resolveSlidesReadModel(event: unknown): {
  session: SlidesSessionInfo
  opened: OpenedPptx
  deck: SlideDeck
} | null {
  const sessionId = (event as { sessionId?: string } | null)?.sessionId
  const path = getCurrentSlidesPath(sessionId)
  if (!path) return null
  const session = getSlidesSession(path)
  if (!session?.opened) return null
  return { session, opened: session.opened, deck: session.opened.deck }
}

/**
 * The pptx-engine hyperlink helpers return `{ elementId, target }` for
 * each link found on a slide; the renderer contract (slides-api-factory
 * ↔ `apps/slides/src/shared/ipc.ts:1396`) expects `{ sourceId, target }`
 * instead. The fields hold the same value, so a one-line rename per item
 * is enough. Empty arrays stay empty so the `for (const link of links)`
 * loop the renderer runs on the result never sees undefined.
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
 * trust across re-parse (see sdk1 §11.42.3), so we use the array
 * index. `hidden` is included so the strip can grey out hidden slides
 * (matches the desktop `getRenderSlides` projection in
 * `apps/slides/src/main/slides-main.ts`).
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

export function registerSlidesStateHandlers(): void {
  // Real render-slides: project each slide to the small shape the
  // renderer's slide-strip / thumbnails need. Returns [] when no
  // session is bound (legacy fallback) so the strip stays empty rather
  // than throwing. The projection uses the live deck, so a slide
  // toggled hidden via setSlideHidden shows up here as hidden=true on
  // the next call.
  registerHandle('slides:get-render-slides', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return []
    return rm.deck.slides.map((s, i) => projectRenderSlide(s, rm.opened.archive, i))
  })
  // Real animations: read the live `<p:timing>` projection from the
  // slide's bodySuffix via getSlideAnimations (sdk1 §11.45 template
  // applied to animations; engine keeps the animation list in sync
  // with apply-txn's setAnimations op so live edits show up here).
  registerHandle('slides:get-animations', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number') return [] as SlideAnimation[]
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return [] as SlideAnimation[]
    return getSlideAnimations(slide)
  })
  // Real chart data: engine's getChartElementData returns the dialog
  // echo shape verbatim (kind/title/categories/series/seriesColors/
  // pointColors). Returns null when no session is bound, slideIndex
  // is out of range, sourceId is not a string, or the element is not
  // a chart — matches the renderer's `if (r)` guard.
  registerHandle('slides:get-chart-data', (event: unknown, slideIndex: unknown, sourceId: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number' || typeof sourceId !== 'string') return null
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return null
    return getChartElementData(slide, sourceId)
  })
  // Real comments: read the live commentsSlide part via
  // getSlideComments (sdk1 §11.47 tier-2 batch). The engine's
  // comments.ts:91 helper mirrors notesPathForSlide so the projection
  // is symmetric — both live parts, both keyed by slideIndex.
  registerHandle('slides:get-comments', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number') return [] as SlideComment[]
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return [] as SlideComment[]
    try {
      return getSlideComments(rm.opened.archive, slide.path)
    } catch {
      // Malformed commentsSlide XML (rare but happens with
      // hand-edited pptx) — fail soft.
      return [] as SlideComment[]
    }
  })
  // Real header/footer echo for the dialog: read the live slide's
  // placeholder state via readHeaderFooter(slide). The engine walks the
  // slide's elements for `ftr` / `dt` / `sldNum` placeholders, so the
  // answer reflects the post-applyHeaderFooter state without a
  // re-parse. For unbound sessions / out-of-range slideIndex, return
  // `{ enabled: false }` so the dialog paints a disabled footer
  // instead of a missing one.
  registerHandle('slides:get-header-footer', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
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
  // Real layouts: enumerate every slideLayout via listSlideLayouts
  // (sdk1 §11.47 tier-2 batch). The engine's SlideLayoutInfo shape
  // (path/name/layoutType/placeholders) is identical to what the
  // renderer's GetLayoutsResult expects under the `layouts` key,
  // so this is a one-line wrap. Unknown session: { layouts: [] }
  // — null at the result envelope level would break the renderer's
  // non-null check.
  registerHandle('slides:get-layouts', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return { layouts: [] as SlideLayoutInfo[] }
    return { layouts: listSlideLayouts(rm.opened.archive) }
  })
  // Single-element link lookup: filter the slide-links projection by
  // sourceId (= elementId). Returns null when no slide session is bound,
  // when slideIndex is out of range, or when the element has no link —
  // matches the renderer's `if (r)` guard in slideshow hit-testing.
  registerHandle('slides:get-link', (event: unknown, slideIndex: unknown, sourceId: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number' || typeof sourceId !== 'string') return null
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return null
    const links = getSlideLinks(rm.opened, slideIndex)
    const found = links.find((l) => l.elementId === sourceId)
    return found ? found.target : null
  })
  // Real notes: read the live notesSlide archive part (apply-txn with
  // setSlideNotes mutates the same archive, so this picks up live edits
  // without re-parsing). For an unknown SSE session or out-of-range
  // slideIndex, return '' — same shape the renderer already tolerates.
  registerHandle('slides:get-notes', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return ''
    if (typeof slideIndex !== 'number' || slideIndex < 0) return ''
    const slide = rm.deck.slides[slideIndex]
    if (!slide) return ''
    try {
      return getSlideNotes(rm.opened.archive, slide.path)
    } catch {
      // Malformed notesSlide XML (some authoring tools produce partial
      // notes) — fail soft so a single bad slide doesn't break the
      // entire notes pane.
      return ''
    }
  })
  // Real sections: read presentation.xml's p14:sectionLst via
  // getSections(opened). Returns the SectionInfo array verbatim
  // (id/name/slideIndices). The engine is the authoritative parser,
  // so sldIds referencing deleted slides are already filtered — no
  // need to re-validate on this side. Unknown session: [] (legacy
  // empty shape).
  registerHandle('slides:get-sections', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return [] as SectionInfo[]
    return getSections(rm.opened)
  })
  // Engine has no morph-key model yet (sdk1 §11.42.6 M4 backlog).
  // Return [] honestly so the renderer doesn't see undefined; once the
  // engine gains `getMorphKeys` this becomes a one-line projection.
  // Real get-shape-keys (sdk1 §11.51): port of the desktop handler
  // at apps/slides/src/main/slides-main.ts:3828. Used by the Morph
  // transition feature in AudienceView / SlideShowView to match
  // shapes across slides before / after — cNvPr id (`spid`) and
  // `name` are stable across reparses; `el.id` (= sourceId) is not.
  // The stub used to return [] which made Morph silently no-op.
  registerHandle('slides:get-shape-keys', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number') return []
    const slide = rm.opened.deck.slides[slideIndex]
    if (!slide) return []
    return slide.elements.map((el) => ({
      sourceId: el.id,
      spid: elementSpid(el),
      name: el.name ?? '',
    }))
  })
  // Real slide-level links: walk every element (groups recursed) and
  // resolve any `a:hlinkClick` against the slide's rels. The rels live
  // in the live archive, so a hyperlink added via setElementHyperlink
  // shows up on the next call without re-parse (same liveness story as
  // §11.45 get-render-slides).
  registerHandle('slides:get-slide-links', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number') return []
    return projectSlideLinks(getSlideLinks(rm.opened, slideIndex))
  })
  // Real slide-size: project the deck's EMU dimensions onto CSS pixels at
  // 96 DPI (9525 EMU per px). The previous hardcoded 960x540 was wrong for
  // any 4:3 / a4 / custom-size deck; the renderer's canvas would render
  // at the wrong aspect ratio until it parsed the deck itself.
  // For unknown paths (renderer hasn't called open-path yet, or the SSE
  // session was evicted) keep returning the 16:9 fallback so the canvas
  // paints *something* instead of 0x0.
  registerHandle('slides:get-slide-size', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return { width: 960, height: 540 }
    const { cx, cy } = rm.deck.size
    return { width: Math.round(cx / EMU_PER_PX), height: Math.round(cy / EMU_PER_PX) }
  })
  // Real run-level links: one entry per text run whose
  // TextRun.hyperlinkRId resolves to a url/slide target via the live
  // rels. Keyed by sourceId (= elementId) + paraIndex + runIndex so the
  // slideshow's hit-test loop can match against layout glyph runs.
  registerHandle('slides:get-run-links', (event: unknown, slideIndex: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof slideIndex !== 'number') return []
    return projectRunLinks(getRunLinks(rm.opened, slideIndex))
  })
  // Real has-slide-clipboard: the engine element clipboard lives on
  // the app (not the session, since the renderer copies in one deck
  // and pastes into another — see §11.42.3 / state.ts comment block).
  // This handler reports whether anything is currently sitting in that
  // clipboard, so the Paste menu item can grey itself out instead of
  // silently doing nothing on an empty clipboard. Returns false for
  // unknown sessions too (legacy fallback — there's nothing in the
  // clipboard from the server's perspective if no session bound).
  registerHandle('slides:has-slide-clipboard', () => {
    return getSlidesElementClipboard().length > 0
  })
  // Real font-catalog / font-missing (sdk1 §11.53): port of the desktop
  // `listFontCatalog()` / `missingCatalogFonts()` in
  // apps/slides/src/main/font-store.ts (M4 backlog closure).
  //
  // The OFL catalog is a generated data table (sha256 + bytes per file);
  // the renderer's contract is just `Array<{ family, script, installed,
  // downloading }>`, so we project to family + script. Web can't track
  // local install state (that lives in the browser's FontFace store), so
  // we report `installed: false / downloading: false` for every family.
  // The renderer falls back to whatever it has locally for layout; the
  // presence of the entry just lets the Font Picker show the option.
  //
  // The catalog ships 21 families (5 latin sub-families + CJK + KR + KR
  // auxiliary). Mirrored verbatim from
  // apps/slides/src/main/font-catalog.ts:15 — the source file stays the
  // generator of record; this projection is the `if (!familyAvailable)`
  // invariant that desktop checks via `fontCdnBaseUrl()`.
  registerHandle('slides:font-catalog', () => {
    return FONT_CATALOG_DATA.map((f) => ({
      family: f.family,
      script: f.script,
      installed: false,
      downloading: false,
    }))
  })
  // Real font-missing: walks every element on every slide, collects the
  // fontFamily off each text run, and returns those that are *both*
  // (a) in the catalog and (b) marked as downloadable-but-not-installed.
  // On web we can't tell what's actually missing locally, so the list
  // collapses to "all catalog families the deck references". The
  // renderer filters by its own FontFace state.
  registerHandle('slides:font-missing', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
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
  // Real chart-color-schemes (sdk1 §11.50): port of the desktop
  // `chartColorSchemes()` in apps/slides/src/main/slides-main.ts:1000
  // (M4 backlog closure). Reads the live deck's theme accent1..6 via
  // parseTheme(theme.xml) and projects to the renderer's
  // chart-color-schemes contract:
  //
  //   Array<{ key, label, colors: string[] }>
  //
  // - key 'default' is empty colors (means "use the chart's existing
  //   palette, don't override")
  // - 'colorful' / 'colorful2' rotate the 6 accents for a visual swap
  // - 'mono-accentN' is a 5-step gradient per accent
  //
  // The desktop uses i18n keys for `label`; on web we hard-code
  // English labels — the renderer's Chart dialog passes the raw string
  // through, no translation layer is required.
  registerHandle('slides:chart-color-schemes', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
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
  registerHandle('slides:clipboard-external', () => ({}))
  registerHandle('slides:clipboard-probe', () => ({}))
  registerHandle('slides:media-data', () => ({}))
  registerHandle('slides:native-clipboard', () => ({}))
  // Real private-font-data: re-walk listEmbeddedFonts(archive) so the
  // renderer can fetch one face's sfnt bytes by index. Each face is
  // typically 100-300 KB (TTF/OTF) so we never broadcast the whole
  // list — the renderer pulls one face at a time when it actually
  // needs to render glyphs. The bytes travel as a plain Uint8Array;
  // the IPC transport handles Buffer/Uint8Array natively.
  // Returns null for unknown session / out-of-range id so the
  // renderer doesn't render with a silently-empty font.
  registerHandle('slides:private-font-data', (event: unknown, id: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm || typeof id !== 'number' || id < 0) return null
    const faces = listEmbeddedFonts(rm.opened.archive)
    const face = faces[id]
    if (!face) return null
    return { data: face.sfnt, typeface: face.typeface, style: face.style }
  })
  // Real private-font-faces: walk presentation.xml's p:embeddedFontLst
  // via listEmbeddedFonts(archive) (sdk1 §11.48 tier-3 batch). The
  // engine returns EmbeddedFontFace { typeface, style, sfnt } — the
  // sfnt bytes are intentionally NOT shipped over IPC (a single face
  // can be 100+ KB and the renderer fetches its own bytes via
  // slides:private-font-data(id) only when it needs to render). We
  // project to { typeface, style } so the Font Picker can show the
  // list and demand-load individual faces on demand.
  registerHandle('slides:private-font-faces', (event: unknown) => {
    const rm = resolveSlidesReadModel(event)
    if (!rm) return [] as Array<Pick<EmbeddedFontFace, 'typeface' | 'style'>>
    return listEmbeddedFonts(rm.opened.archive).map((f) => ({
      typeface: f.typeface,
      style: f.style,
    }))
  })
  // cloud-gen-status stays idle: the actual cloud-generation flow
  // needs upstream infrastructure (image generation provider, asset
  // upload, polling) that the web build doesn't have. The renderer
  // falls back to local-only generation when this returns idle, so
  // returning idle is the honest "not implemented here" shape rather
  // than a fake-progress object that would lie about work being done.
  registerHandle('slides:cloud-gen-status', () => ({ status: 'idle' as const }))

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
