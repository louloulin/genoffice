/**
 * Slides element-manipulation channels — add/edit/delete/transform/copy/paste
 * of slides, elements, charts, tables, text, ink, media, etc.
 *
 * The web build reuses `@genoffice/pptx-ops`'s `runTxn` executor — the same
 * validated, journaled transaction engine the desktop main process drives
 * from `apps/slides/src/main/slides-main.ts:1485`. Every renderer-emitted op
 * (58 total: addElement / setFill / setTransform / setFont / addChart / etc.)
 * lands mutations on the live `OpenedPptx` so `slides:save` serialises a real
 * deck. Unknown ops still answer a structured `{ applied: false, failures }`
 * so a missing handler never silently no-ops a renderer-side edit.
 *
 * ── Why this file is shaped the way it is ─────────────────────────────────
 *
 * These channels (`slides:edit-transform`, `slides:delete-element`,
 * `slides:set-element-font`, `slides:undo`, …) are what the renderer calls
 * from the UI — the toolbar, the context menu, the arrange panel, ⌘Z. They
 * used to answer the literal `{ ok: true }` while touching nothing, and the
 * response SHAPE did not match the contract either: the renderer does
 *
 *     window.slidesApi.deleteElement({...}).then((r) => r && applySlide(current, r))
 *
 * where `applySlide` takes a `RenderSlide`. `{ok:true}` is truthy, so the
 * renderer took its success branch and stored an object with no `nodes`
 * array in place of the page — the canvas went blank and every later edit
 * compounded from corrupt state. That is strictly worse than an error: the
 * user cannot tell the operation failed, and nothing surfaces anywhere.
 *
 * So each channel below answers the shape its counterpart in
 * `apps/slides/src/shared/ipc.ts` declares (`RenderSlide | null`,
 * `{slide, sourceId} | null`, `RenderSlide[] | null`, `number`, `boolean`),
 * and returns `null` when there is no live session — matching the desktop
 * handlers, so the renderer's `if (r)` guard leaves the document alone.
 *
 * `STUBBED_SLIDES_CHANNELS` lists the few channels that still only
 * acknowledge, with the reason, so the boundary is auditable as data rather
 * than implied by a comment.
 */
import { join } from 'node:path'
import { registerHandle, FILES_DIR, storageKeyFromPath } from '../common/index'
import {
  getSlidesDirty,
  getSlidesFitWidth,
  getSlidesSession,
  setSlidesDirty,
  getCurrentSlidesPath,
  getSlidesElementClipboard,
  setSlidesElementClipboard,
  pushSlidesHistory,
  undoSlidesHistory,
  redoSlidesHistory,
  beginSlidesHistoryBatch,
  endSlidesHistoryBatch,
  registerSlidesAiSnapshot,
  restoreSlidesAiSnapshot,
  type SlidesSessionInfo,
} from './state'
import { buildWebRenderSlide, buildWebRenderSlides } from './core'
import {
  copyElementData,
  editTableStructure,
  getSections,
  getSlideComments,
  type OpenedPptx,
  type TableStructureOp,
} from '@genoffice/pptx-engine'
import { runTxn, type Op } from '@genoffice/pptx-ops'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'

/**
 * Resolve the slides session for a legacy IPC channel. Legacy channels
 * (`slides:edit-text` / `slides:edit-fill` / `slides:edit-stroke` /
 * `slides:add-element`) don't carry the path in their args; the renderer
 * held it in renderer-side state instead. We track the equivalent on the
 * server side via `setCurrentSlidesPath(sessionId, path)` (called from
 * `slides:open-path`), then look it up here.
 */
function legacySessionPath(event: unknown): string | undefined {
  const sessionId = (event as { sessionId?: string } | null | undefined)?.sessionId
  return getCurrentSlidesPath(sessionId)
}

/** The live session for a legacy channel, or null when none is open. */
function legacySession(event: unknown): SlidesSessionInfo | undefined {
  const path = legacySessionPath(event)
  return path ? getSlidesSession(path) : undefined
}

/** px → EMU at the viewport width the renderer is drawing at. Mirrors the
 *  desktop `toEmu` closure: the op layer speaks EMU, the renderer speaks px. */
function makeToEmu(opened: OpenedPptx, fitWidthPx: number) {
  const baseWidthPx = opened.deck.size.cx / EMU_PER_PX_96
  const scale = fitWidthPx / baseWidthPx
  return (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
}

/**
 * Run one op for a renderer channel. Returns the `runTxn` result, or null when
 * there is no live session (matching the desktop handlers' `if (!session)
 * return null`, so the renderer's `if (r)` guard is a no-op rather than a
 * false success).
 *
 * Every mutating channel goes through here, which is why history and the dirty
 * flag cannot drift between them: one executor, one journal, one snapshot.
 */
function commit(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo) => Op | Op[] | null,
): { session: SlidesSessionInfo; applied: boolean } | null {
  const session = legacySession(event)
  if (!session) {
    // The channel's declared type has no error variant, so the honest answer is
    // `null` — the renderer's `if (r)` guard then leaves the document alone.
    // (A `{ok:false}` object would be TRUTHY and get handed to applySlide as if
    // it were a page.) Log so the cause is findable server-side: a renderer
    // that forgot the session header is otherwise invisible here.
    warnNoSession(channel)
    return null
  }
  const built = build(session)
  if (!built) return null
  const ops = Array.isArray(built) ? built : [built]
  // snapshot BEFORE the mutation: it is the pre-edit state undo restores.
  pushSlidesHistory(session)
  const r = runTxn(session.opened, { ops, isolation: 'atomic' })
  if (!r.applied) {
    // A failed op must not leave a snapshot behind, or Undo would appear to do
    // nothing (it would restore the state the failure already left in place).
    session.undoStack.pop()
    const first = r.failures?.[0]
    warnOpFailed(channel, first?.error ?? `${ops[0]?.op ?? 'op'} failed`)
    return null
  }
  setSlidesDirty(session.path, true)
  return { session, applied: true }
}

/* Failures answer `null` (see above), which is correct but quiet. These loggers
 * are the server-side record: without them a renderer-side mistake looks
 * identical to a legitimate no-op. */
function warnNoSession(channel: string): void {
  process.stderr.write(
    `[slides] ${channel}: no open deck for this session — the renderer must call slides:open-path first (answering null)\n`,
  )
}

function warnOpFailed(channel: string, reason: string): void {
  process.stderr.write(`[slides] ${channel}: ${reason} (answering null)\n`)
}

/**
 * Argument validation failed.
 *
 * Answers `null`, like every other failure in this file: the shapes these
 * channels declare have no error variant, and `{ok:false}` is TRUTHY — the
 * renderer would hand it to `applySlide` as if it were a page, which is the
 * exact bug this module exists to remove. `null` makes the renderer's `if (r)`
 * guard a no-op, so a malformed call leaves the document alone.
 *
 * Logged so a caller bug is still findable server-side, where a bare `null`
 * would look identical to a legitimate no-op.
 */
function badArgs(message: string): null {
  process.stderr.write(`[slides] ${message} (answering null)\n`)
  return null
}

/** The re-rendered page after a successful `commit`, or null. */
function commitSlide(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo) => Op | Op[] | null,
  slideIndex: number,
) {
  const r = commit(event, channel, build)
  if (!r) return null
  return buildWebRenderSlide(r.session.opened, r.session.fitWidthPx, slideIndex)
}

/** The re-rendered whole deck after a successful `commit`, or null. */
function commitAllSlides(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo) => Op | Op[] | null,
) {
  const r = commit(event, channel, build)
  if (!r) return null
  return buildWebRenderSlides(r.session.opened, r.session.fitWidthPx)
}

/** `{slide, sourceId}` — the shape the insert/add channels declare. The id
 *  comes from the op's own record (`created[0]`), not a timestamp: a
 *  fabricated id made the renderer select an element that did not exist. */
function commitCreated(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo) => Op | Op[] | null,
  slideIndex: number,
) {
  const session = legacySession(event)
  if (!session) {
    warnNoSession(channel)
    return null
  }
  const built = build(session)
  if (!built) return null
  const ops = Array.isArray(built) ? built : [built]
  pushSlidesHistory(session)
  const r = runTxn(session.opened, { ops, isolation: 'atomic' })
  const created = r.applied ? r.records?.[0]?.created?.[0] : undefined
  if (!r.applied || !created) {
    session.undoStack.pop()
    warnOpFailed(channel, r.failures?.[0]?.error ?? `${ops[0]?.op ?? 'op'} created no element`)
    return null
  }
  setSlidesDirty(session.path, true)
  const slide = buildWebRenderSlide(session.opened, session.fitWidthPx, slideIndex)
  return slide ? { slide, sourceId: created } : null
}

/** `boolean` — the shape the notes/transition/animation setters declare.
 *  They used to answer `{ok:true}` (truthy object) where the renderer reads a
 *  boolean, so "did it apply?" was always yes. */
function commitBool(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo) => Op | Op[] | null,
): boolean {
  return commit(event, channel, build) !== null
}

/**
 * Channels that still answer a bare acknowledgement, with the reason. Kept as
 * data (not prose) so a test can assert the set only shrinks and reviewers can
 * see the exact boundary in one place.
 *
 * Every entry must be a channel whose document mutation reaches the model
 * through `slides:apply-txn` instead, or whose effect is renderer-owned state
 * the server cannot observe.
 */
export const STUBBED_SLIDES_CHANNELS: Record<string, string> = {
  // These carry an OS clipboard handle owned by the renderer; the server has
  // no clipboard, and the paste that matters arrives as a `pasteSlide` op.
  'slides:copy-slide': 'renderer owns the OS clipboard; the deck change travels via slides:apply-txn',
  'slides:paste-slide': 'renderer owns the OS clipboard; the deck change travels via slides:apply-txn',
  'slides:repaste-slide': 'renderer owns the OS clipboard; the deck change travels via slides:apply-txn',
  // Presenter view is a second browser window the renderer opens; there is no
  // server-side projector to start, and answering a fabricated success would
  // make the UI believe a presenter window exists.
  'slides:presenter-start': 'presenter view is a renderer-owned window; no server-side projector exists',
  'slides:presenter-end': 'presenter view is a renderer-owned window; no server-side projector exists',
  'slides:presenter-swap': 'presenter view is a renderer-owned window; no server-side projector exists',
  'slides:audience-ready': 'presenter view is a renderer-owned window; no server-side projector exists',
  // Fullscreen is a browser API the renderer drives directly (webFullscreen in
  // web-bridge.ts); the server has no display to switch.
  'slides:show-fullscreen': 'renderer owns the browser fullscreen API; the server has no display',
}

/** EMU per typographic point (2.54 cm / 72 pt, inches × 914400). */
const EMU_PER_PT = 12700

/**
 * Run one op for a renderer channel and answer in the shape that channel's
 * caller expects.
 *
 * `commitSlide` returns a single page, which is enough for the element
 * channels but not for the slide-lifecycle ones: those return the re-rendered
 * slide list (and, for inserts, the new index) because the renderer calls
 * `setSlides(...)` with it. Answering `{ok:true}` there made the renderer keep
 * its old array, which is exactly how the stub hid the missing mutation.
 *
 * Returns `null` for "no live session", matching the desktop handlers — the
 * renderer's `if (r)` guard then leaves the document untouched instead of
 * reporting a success that did not happen.
 */
function applyLegacyMutation(
  event: unknown,
  op: Op,
): { slides: unknown[]; index: number } | null {
  const session = legacySession(event)
  if (!session) return null
  pushSlidesHistory(session)
  const r = runTxn(session.opened, { ops: [op], isolation: 'atomic' })
  if (!r.applied) {
    session.undoStack.pop()
    const first = r.failures?.[0]
    return badArgs(`${op.op}: ${first?.error ?? 'op failed'}`)
  }
  setSlidesDirty(session.path, true)
  const slides = buildWebRenderSlides(session.opened, session.fitWidthPx)
  // Insert ops put the new page immediately after the anchor; every other
  // op leaves the selection where it was. The renderer clamps this itself,
  // so a slightly-off index is survivable — a missing slide is not.
  const anchorIndex = typeof op.target?.slide === 'number' ? op.target.slide : 0
  const inserts =
    op.op === 'addBlankSlide' || op.op === 'duplicateSlide' || op.op === 'addSlideWithLayout'
  if (inserts) return { slides, index: anchorIndex + 1 }
  // A move reports where the slide landed; the renderer sets its current index
  // from this, so echoing the source would leave the selection on a page the
  // user just dragged away from.
  if (op.op === 'moveSlide' && typeof op.to === 'number') return { slides, index: op.to }
  return { slides, index: anchorIndex }
}

/**
 * Paste-family channels (`pasteElements` / `duplicateElements`) answer
 * `{ slide, sourceIds }` — the whole page plus every id the op minted, because
 * a paste renumbers ids across the page and the renderer has to reselect the
 * copies by their real ids.
 */
function commitPasted(
  event: unknown,
  channel: string,
  slideIndex: number,
  build: (session: SlidesSessionInfo) =>
    | { items: unknown[]; dx: number; dy: number }
    | null,
) {
  const session = legacySession(event)
  if (!session) {
    warnNoSession(channel)
    return null
  }
  const built = build(session)
  if (!built) return null
  pushSlidesHistory(session)
  const r = runTxn(session.opened, {
    ops: [
      {
        op: 'pasteElements',
        target: { slide: slideIndex },
        items: built.items,
        dx: built.dx,
        dy: built.dy,
      } as unknown as Op,
    ],
    isolation: 'atomic',
  })
  const sourceIds = r.applied ? (r.records?.[0]?.created ?? []) : []
  if (!r.applied || sourceIds.length === 0) {
    session.undoStack.pop()
    warnOpFailed(channel, r.failures?.[0]?.error ?? 'pasteElements created no element')
    return null
  }
  setSlidesDirty(session.path, true)
  const slide = buildWebRenderSlide(session.opened, session.fitWidthPx, slideIndex)
  return slide ? { slide, sourceIds } : null
}

/** First `target.slide` among a script's ops — `apply-edit-script` answers with
 *  the page the script touched, and the renderer applies it to the current one. */
function firstSlideIndex(ops: Op[]): number {
  for (const op of ops) {
    if (typeof op.target?.slide === 'number') return op.target.slide
  }
  return 0
}

export function registerSlidesElementHandlers(): void {
  // ----- slide-level mutations ---------------------------------------------
  /* Real implementations. Each builds the matching `Op` and routes it through
   * the same executor `slides:apply-txn` uses, so the live `OpenedPptx` is
   * actually mutated and `slides:save` persists the result. The response
   * shapes match the desktop handlers because the renderer consumes them
   * directly (`r.slides` / `r.index`).
   *
   * Before this, all of these returned `{ ok: true, slideId: 'slide-<now>' }`
   * without touching the model: "insert slide" appeared to succeed, the slide
   * list was re-rendered from the stale renderer array, and the new slide was
   * never in the saved file. */
  registerHandle('slides:add-blank-slide', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { sourceIndex?: number; fitWidthPx?: number }
    if (typeof o.sourceIndex !== 'number') {
      return badArgs('slides:add-blank-slide requires { sourceIndex }')
    }
    return applyLegacyMutation(event, { op: 'addBlankSlide', target: { slide: o.sourceIndex } })
  })
  registerHandle('slides:add-slide', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { sourceIndex?: number; clearText?: boolean }
    if (typeof o.sourceIndex !== 'number') {
      return badArgs('slides:add-slide requires { sourceIndex }')
    }
    return applyLegacyMutation(event, {
      op: 'duplicateSlide',
      target: { slide: o.sourceIndex },
      ...(o.clearText !== undefined ? { clearText: o.clearText } : {}),
    })
  })
  registerHandle('slides:add-slide-with-layout', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { sourceIndex?: number; layoutPath?: string }
    if (typeof o.sourceIndex !== 'number') {
      return badArgs('slides:add-slide-with-layout requires { sourceIndex }')
    }
    // A layout-less request is the same operation as a blank slide; the op is
    // named for the insert point, so slide it in after the current one.
    if (typeof o.layoutPath !== 'string' || !o.layoutPath) {
      return applyLegacyMutation(event, { op: 'addBlankSlide', target: { slide: o.sourceIndex } })
    }
    return applyLegacyMutation(event, {
      op: 'addSlideWithLayout',
      target: { slide: o.sourceIndex },
      layoutPath: o.layoutPath,
    })
  })
  registerHandle('slides:delete-slide', (event: unknown, slideIndex: unknown) => {
    if (typeof slideIndex !== 'number') {
      return badArgs('slides:delete-slide requires a slide index')
    }
    // The renderer replaces its whole list with the response, and refuses to
    // delete the last slide (`else if (ctx.slides.length <= 1)`), so a
    // `slides` array is the contract — not the `{ok:true}` the stub sent.
    return applyLegacyMutation(event, { op: 'deleteSlide', target: { slide: slideIndex } })
  })
  registerHandle('slides:move-slide', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { fromIndex?: number; toIndex?: number }
    if (typeof o.fromIndex !== 'number' || typeof o.toIndex !== 'number') {
      return badArgs('slides:move-slide requires { fromIndex, toIndex }')
    }
    return applyLegacyMutation(event, {
      op: 'moveSlide',
      target: { slide: o.fromIndex },
      to: o.toIndex,
    })
  })

  // ----- element add --------------------------------------------------------
  /* Contract: `{ slide: RenderSlide; sourceId: string } | null`. The id comes
   * from the op's own record — a fabricated `text-<now>` would leave the
   * renderer selecting an element that does not exist. */
  registerHandle('slides:add-element', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown>
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-element requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-element',
      (session) => {
        const toEmu = makeToEmu(session.opened, (o.fitWidthPx as number) ?? session.fitWidthPx)
        // `text` is the renderer's convenience form; the op layer speaks
        // paragraphs. Splitting here keeps the op contract single-shaped
        // (the desktop shim splits identically, slides-main.ts:1963).
        const paragraphs =
          Array.isArray(o.paragraphs) && o.paragraphs.length
            ? o.paragraphs
            : typeof o.text === 'string' && o.text
              ? o.text.split('\n').map((line) => ({ runs: [{ text: line }] }))
              : undefined
        const stroke = o.stroke as { color: string; widthPt: number } | undefined
        return {
          op: 'addElement',
          target: { slide: o.slideIndex as number },
          kind: o.kind,
          offset: {
            x: toEmu((o.xPx as number) ?? 0),
            y: toEmu((o.yPx as number) ?? 0),
            cx: toEmu((o.wPx as number) ?? 0),
            cy: toEmu((o.hPx as number) ?? 0),
          },
          ...(paragraphs ? { paragraphs } : {}),
          ...(o.fillColor ? { fill: o.fillColor } : {}),
          ...(stroke
            ? { stroke: { color: stroke.color, widthEmu: Math.round(stroke.widthPt * EMU_PER_PT) } }
            : {}),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:add-table', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      fitWidthPx?: number
      xPx?: number
      yPx?: number
      wPx?: number
      hPx?: number
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-table requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-table',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'addTable',
          target: { slide: o.slideIndex as number },
          rows: o.rows,
          cols: o.cols,
          offset: {
            x: toEmu(o.xPx ?? 0),
            y: toEmu(o.yPx ?? 0),
            cx: toEmu(o.wPx ?? 0),
            cy: toEmu(o.hPx ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:add-chart', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      fitWidthPx?: number
      kind?: string
      xPx?: number
      yPx?: number
      wPx?: number
      hPx?: number
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-chart requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-chart',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'addChart',
          target: { slide: o.slideIndex as number },
          // `barH` is a renderer-side name for the same bar chart with a
          // horizontal direction — the desktop handler translates it too.
          kind: o.kind === 'barH' ? 'bar' : o.kind,
          ...(o.kind === 'barH' ? { barDir: 'bar' } : {}),
          categories: o.categories,
          series: o.series,
          offset: {
            x: toEmu(o.xPx ?? 0),
            y: toEmu(o.yPx ?? 0),
            cx: toEmu(o.wPx ?? 0),
            cy: toEmu(o.hPx ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:add-smartart', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      fitWidthPx?: number
      xPx?: number
      yPx?: number
      wPx?: number
      hPx?: number
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-smartart requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-smartart',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'addSmartArt',
          target: { slide: o.slideIndex as number },
          layout: o.layout,
          items: o.items,
          offset: {
            x: toEmu(o.xPx ?? 0),
            y: toEmu(o.yPx ?? 0),
            cx: toEmu(o.wPx ?? 0),
            cy: toEmu(o.hPx ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  // sdk1 §11.91 — the AddImageBytesOp contract (shared/ipc.ts:910) and the
  // desktop main handler (slides-main.ts:1187) both read `op.base64`, and
  // the web bridge (web-bridge.ts:147) sends `base64: bytesToBase64(bytes)`.
  // Reading `o.bytes` here dereferenced undefined, so `reqBytes` always
  // threw and the channel answered null — every web image insert silently
  // failed. Validate the field up front so the error is at least visible.
  registerHandle('slides:add-image-bytes', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      fitWidthPx?: number
      base64?: string
      ext?: string
      xPx?: number
      yPx?: number
      wPx?: number
      hPx?: number
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-image-bytes requires { slideIndex, ... }')
    }
    if (typeof o.base64 !== 'string' || !o.base64) {
      return badArgs('slides:add-image-bytes requires { base64 } (non-empty string)')
    }
    return commitCreated(
      event,
      'slides:add-image-bytes',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'addPicture',
          target: { slide: o.slideIndex as number },
          bytes: o.base64,
          ext: o.ext,
          offset: {
            x: toEmu(o.xPx ?? 0),
            y: toEmu(o.yPx ?? 0),
            cx: toEmu(o.wPx ?? 0),
            cy: toEmu(o.hPx ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  // sdk1 §11.91 — same root cause as slides:add-image-bytes above:
  // AddMediaBytesOp contract (shared/ipc.ts:935) declares base64, the
  // desktop reads op.base64 (slides-main.ts:3619), the bridge sends
  // base64 (web-bridge.ts:166), but this handler was reading o.bytes
  // AND doing `...o` which leaked the bridge's px-shaped fields into the
  // EMU-shaped executor op. The fix forwards only the fields the executor
  // consumes and centres at 60% deck width / 16:9 to mirror desktop.
  registerHandle('slides:add-media-bytes', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      kind?: 'video' | 'audio'
      base64?: string
      ext?: string
      name?: string
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-media-bytes requires { slideIndex, ... }')
    }
    if (typeof o.base64 !== 'string' || !o.base64) {
      return badArgs('slides:add-media-bytes requires { base64 } (non-empty string)')
    }
    if (o.kind !== 'video' && o.kind !== 'audio') {
      return badArgs('slides:add-media-bytes requires { kind: "video" | "audio" }')
    }
    return commitCreated(
      event,
      'slides:add-media-bytes',
     (session) => {
        const deckSize = session.opened.deck.size
        const cx = Math.round(deckSize.cx * 0.6)
        const cy = Math.round((cx * 9) / 16)
        return {
          op: 'addMedia',
          target: { slide: o.slideIndex as number },
          kind: o.kind,
          bytes: o.base64,
          ext: o.ext,
          offset: {
            x: Math.round((deckSize.cx - cx) / 2),
            y: Math.round((deckSize.cy - cy) / 2),
            cx,
            cy,
          },
          ...(typeof o.name === 'string' && o.name ? { name: o.name } : {}),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:add-ink', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & {
      slideIndex?: number
      fitWidthPx?: number
      ext?: string
      xPx?: number
      yPx?: number
      wPx?: number
      hPx?: number
    }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-ink requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-ink',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        // One transparent PNG per stroke, carried as a picture element — the
        // desktop records the same shape (cNvPr name + descr JSON of the points).
        return {
          op: 'addPicture',
          target: { slide: o.slideIndex as number },
          bytes: o.bytes,
          ext: o.ext,
          name: o.name,
          descr: o.descr,
          offset: {
            x: toEmu(o.xPx ?? 0),
            y: toEmu(o.yPx ?? 0),
            cx: toEmu(o.wPx ?? 0),
            cy: toEmu(o.hPx ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  // `slides:add-text` is not reachable from the renderer (no factory method and
  // no caller in apps/slides/src). It is kept answerable for API compatibility,
  // and routes through the generic addElement op so an external caller that
  // does use it gets a real element rather than a fabricated id.
  registerHandle('slides:add-text', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:add-text requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:add-text',
     (session) => {
        const toEmu = makeToEmu(session.opened, (o.fitWidthPx as number) ?? session.fitWidthPx)
        return {
          op: 'addElement',
          target: { slide: o.slideIndex as number },
          kind: 'text',
          ...o,
          xPx: undefined,
          yPx: undefined,
          wPx: undefined,
          hPx: undefined,
          offset: {
            x: toEmu((o.xPx as number) ?? 0),
            y: toEmu((o.yPx as number) ?? 0),
            cx: toEmu((o.wPx as number) ?? 0),
            cy: toEmu((o.hPx as number) ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })

  // ----- element edit -------------------------------------------------------
  registerHandle('slides:edit-text', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string; paragraphs?: unknown; groupId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-text requires { slideIndex, sourceId, paragraphs }')
    }
    return commitSlide(
      event,
      'slides:edit-text',
     () => ({
        op: 'setText',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        paragraphs: o.paragraphs,
        ...(o.groupId ? { group: o.groupId } : {}),
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-fill', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string; fill?: unknown; groupId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-fill requires { slideIndex, sourceId, fill }')
    }
    return commitSlide(
      event,
      'slides:edit-fill',
     () => ({
        op: 'setFill',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        fill: o.fill,
        ...(o.groupId ? { group: o.groupId } : {}),
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-stroke', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as {
      slideIndex?: number
      sourceId?: string
      stroke?: { widthPt?: number } | null
      groupId?: string
    }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-stroke requires { slideIndex, sourceId, stroke }')
    }
    return commitSlide(
      event,
      'slides:edit-stroke',
     () => ({
        op: 'setStroke',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        // The renderer speaks points; the op layer speaks EMU. This pt→EMU
        // conversion is surface translation and stays here (the desktop shim
        // in slides-main.ts:2018 does exactly the same).
        stroke: o.stroke
          ? { ...o.stroke, widthEmu: Math.round((o.stroke.widthPt ?? 0) * EMU_PER_PT) }
          : o.stroke,
        ...(o.groupId ? { group: o.groupId } : {}),
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-background', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:edit-background requires { slideIndex, ... }')
    }
    return commitAllSlides(
      event,
      'slides:edit-background',
      () => ({ op: 'setBackground', ...o, target: { slide: o.slideIndex as number } }) as unknown as Op)
  })
  registerHandle('slides:edit-chart', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-chart requires { slideIndex, sourceId, ... }')
    }
    return commitCreated(
      event,
      'slides:edit-chart',
     () => ({
        op: 'setChart',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        patch: o,
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-connector-endpoints', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-connector-endpoints requires { slideIndex, sourceId, ... }')
    }
    return commitSlide(
      event,
      'slides:edit-connector-endpoints',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'setConnectorEndpoints',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          p1: { x: toEmu((o.x1Px as number) ?? 0), y: toEmu((o.y1Px as number) ?? 0) },
          p2: { x: toEmu((o.x2Px as number) ?? 0), y: toEmu((o.y2Px as number) ?? 0) },
          start: o.start,
          end: o.end,
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-image-fill', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; targets?: unknown }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:edit-image-fill requires { slideIndex, targets }')
    }
    return commitSlide(
      event,
      'slides:edit-image-fill',
     () => ({ op: 'setImageFill', target: { slide: o.slideIndex as number }, ...o }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-picture-opacity', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-picture-opacity requires { slideIndex, sourceId, opacity }')
    }
    return commitSlide(
      event,
      'slides:edit-picture-opacity',
     () => ({
        op: 'setPictureOpacity',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-picture-src-rect', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-picture-src-rect requires { slideIndex, sourceId, srcRect }')
    }
    return commitSlide(
      event,
      'slides:edit-picture-src-rect',
     (session) => {
        const boxPx = o.boxPx as { x: number; y: number; w: number; h: number } | undefined
        let box: Record<string, number> | undefined
        if (boxPx) {
          const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
          // Crop confirm shrinks the frame in the SAME undo step, so one undo
          // restores both the crop and the box.
          box = { x: toEmu(boxPx.x), y: toEmu(boxPx.y), cx: toEmu(boxPx.w), cy: toEmu(boxPx.h) }
        }
        return {
          op: 'setPictureSrcRect',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          srcRect: o.srcRect,
          ...(box ? { box } : {}),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-table-cell', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-table-cell requires { slideIndex, sourceId, row, col }')
    }
    return commitSlide(
      event,
      'slides:edit-table-cell',
     () => ({
        op: 'setTableCell',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-table-style', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-table-style requires { slideIndex, sourceId, ... }')
    }
    return commitCreated(
      event,
      'slides:edit-table-style',
     () => ({
        op: 'setTableStyle',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:edit-transform', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:edit-transform requires { slideIndex, sourceId, ... }')
    }
    return commitSlide(
      event,
      'slides:edit-transform',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'setTransform',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          box: {
            x: toEmu((o.xPx as number) ?? 0),
            y: toEmu((o.yPx as number) ?? 0),
            cx: toEmu((o.wPx as number) ?? 0),
            cy: toEmu((o.hPx as number) ?? 0),
          },
          rotDeg: o.rotationDeg,
          // Tables redistribute gridCol widths / tr heights so the file matches
          // the frame — unless the edit targets a group child.
          ...(o.groupId ? { group: o.groupId } : { resizeTableGrid: true }),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:batch-edit-transform', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as {
      slideIndex?: number
      fitWidthPx?: number
      items?: Array<{ sourceId: string; xPx: number; yPx: number; wPx: number; hPx: number; rotationDeg: number }>
    }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.items)) {
      return badArgs('slides:batch-edit-transform requires { slideIndex, items }')
    }
    // One atomic transaction for the whole selection: align/distribute is one
    // undo step, and the executor's plan step reproduces the legacy
    // "every element must exist" gate.
    return commitSlide(
      event,
      'slides:batch-edit-transform',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return o.items!.map((item) => ({
          op: 'setTransform',
          target: { slide: o.slideIndex as number, el: item.sourceId },
          box: {
            x: toEmu(item.xPx),
            y: toEmu(item.yPx),
            cx: toEmu(item.wPx),
            cy: toEmu(item.hPx),
          },
          rotDeg: item.rotationDeg,
          resizeTableGrid: true,
        })) as unknown as Op[]
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:delete-element', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:delete-element requires { slideIndex, sourceId }')
    }
    return commitSlide(
      event,
      'slides:delete-element',
     () => ({
        op: 'deleteElement',
        target: { slide: o.slideIndex as number, el: o.sourceId },
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:duplicate-elements', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as {
      slideIndex?: number
      sourceIds?: string[]
      dxPx?: number
      dyPx?: number
      fitWidthPx?: number
    }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) {
      return badArgs('slides:duplicate-elements requires { slideIndex, sourceIds }')
    }
    return commitPasted(
      event,
      'slides:duplicate-elements',
      o.slideIndex,
      (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        // Duplicate in place reads the live elements (not the app clipboard) so
        // ⌘D never clobbers what the user copied earlier.
        const slide = session.opened.deck.slides[o.slideIndex as number]
        if (!slide) return null
        const items = o.sourceIds!
          .map((id) => slide.elements.find((el) => el.id === id))
          .filter((el): el is NonNullable<typeof el> => !!el)
          .map((el) => copyElementData(session.opened, slide, el))
        if (!items.length) return null
        return {
          items,
          dx: toEmu(o.dxPx ?? 0),
          dy: toEmu(o.dyPx ?? 0),
        }
      },
    )
  })
  registerHandle('slides:flip-elements', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceIds?: string[] }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) {
      return badArgs('slides:flip-elements requires { slideIndex, sourceIds, axis }')
    }
    return commitSlide(
      event,
      'slides:flip-elements',
     () => ({
        op: 'flipElements',
        target: { slide: o.slideIndex as number },
        els: o.sourceIds,
        axis: o.axis,
        ...(o.groupId ? { group: o.groupId } : {}),
      }),
      o.slideIndex,
    )
  })
  registerHandle('slides:reorder-element', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:reorder-element requires { slideIndex, sourceId, dir }')
    }
    return commitSlide(
      event,
      'slides:reorder-element',
     () => ({
        op: 'reorderElement',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        dir: o.dir,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:insert-image', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; fitWidthPx?: number; ext?: string }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:insert-image requires { slideIndex, ... }')
    }
    return commitCreated(
      event,
      'slides:insert-image',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'addPicture',
          target: { slide: o.slideIndex as number },
          bytes: o.bytes,
          ext: o.ext,
          offset: {
            x: toEmu((o.xPx as number) ?? 0),
            y: toEmu((o.yPx as number) ?? 0),
            cx: toEmu((o.wPx as number) ?? 0),
            cy: toEmu((o.hPx as number) ?? 0),
          },
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:set-element-font', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceIds?: string[] }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) {
      return badArgs('slides:set-element-font requires { slideIndex, sourceIds, ... }')
    }
    // One op per element, `per_op` isolation: an image in the selection has no
    // text and is skipped, while the text elements still change (the desktop
    // handler is explicit about this — "All non-text elements (images etc.):
    // nothing happened").
    return commitSlide(
      event,
      'slides:set-element-font',
     () => {
        const font = {
          fontFamily: o.fontFamily,
          fontSizePt: o.fontSizePt,
          strike: o.strike,
          bold: o.bold,
          italic: o.italic,
          underline: o.underline,
          color: o.color,
        }
        return o.sourceIds!.map((id) => ({
          op: 'setFont',
          target: { slide: o.slideIndex as number, el: id },
          font,
          ...(o.groupId ? { group: o.groupId } : {}),
        })) as unknown as Op[]
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:set-element-paragraph-format', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceIds?: string[] }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) {
      return badArgs('slides:set-element-paragraph-format requires { slideIndex, sourceIds, ... }')
    }
    return commitSlide(
      event,
      'slides:set-element-paragraph-format',
     () => {
        const { slideIndex, sourceIds, ...format } = o
        return sourceIds!.map((id) => ({
          op: 'setParagraphFormat',
          target: { slide: slideIndex as number, el: id },
          format,
        })) as unknown as Op[]
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:set-table-cell-anchor', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:set-table-cell-anchor requires { slideIndex, sourceId, row, col }')
    }
    return commitSlide(
      event,
      'slides:set-table-cell-anchor',
     () => ({
        op: 'setTableCellAnchor',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:set-table-col-width', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:set-table-col-width requires { slideIndex, sourceId, col, wPx }')
    }
    return commitSlide(
      event,
      'slides:set-table-col-width',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'setTableColWidth',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          col: o.col,
          wEmu: toEmu((o.wPx as number) ?? 0),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:set-table-row-height', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:set-table-row-height requires { slideIndex, sourceId, row, hPx }')
    }
    return commitSlide(
      event,
      'slides:set-table-row-height',
     (session) => {
        const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
        return {
          op: 'setTableRowHeight',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          row: o.row,
          hEmu: toEmu((o.hPx as number) ?? 0),
        } as unknown as Op
      },
      o.slideIndex,
    )
  })
  registerHandle('slides:table-merge', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:table-merge requires { slideIndex, sourceId, kind, row, col }')
    }
    return commitCreated(
      event,
      'slides:table-merge',
     () => ({
        op: 'tableMerge',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  // Real table-structure (sdk1 §A.5 closure + §11.49): the legacy stub
  // returned {} which the renderer's `if (r)` guard read as truthy, so a
  // right-click "insert row above" silently pretended to succeed. The
  // engine exports editTableStructure(opened, slideIndex, elementId, op)
  // returning { slide, elementId } | null (null on merged cells / out of
  // range / delete-of-last-row — see engine source for the full set of
  // refusal reasons). The renderer's contract is { slide, sourceId } | null
  // so we rename elementId → sourceId on the way out.
  //
  // Unlike the other table-* channels this one does NOT go through runTxn:
  // the op layer has no tableStructure op; editTableStructure is a
  // dedicated engine call that does its own XML surgery + materialization.
  // We still take a snapshot before and pop it on failure so Undo /
  // redo remain consistent with every other mutation channel.
  registerHandle('slides:table-structure', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as {
      slideIndex?: number
      sourceId?: string
      kind?: TableStructureOp['kind']
      index?: number
      before?: boolean
    }
    if (
      typeof o.slideIndex !== 'number' ||
      typeof o.sourceId !== 'string' ||
      (o.kind !== 'insert-row' &&
        o.kind !== 'delete-row' &&
        o.kind !== 'insert-col' &&
        o.kind !== 'delete-col') ||
      typeof o.index !== 'number'
    ) {
      return badArgs(
        'slides:table-structure requires { slideIndex, sourceId, kind, index, before? }',
      )
    }
    const session = legacySession(event)
    if (!session) {
      warnNoSession('slides:table-structure')
      return null
    }
    const structOp: TableStructureOp = {
      kind: o.kind,
      index: o.index,
      ...(typeof o.before === 'boolean' ? { before: o.before } : {}),
    }
    pushSlidesHistory(session)
    const r = editTableStructure(session.opened, o.slideIndex, o.sourceId, structOp)
    if (!r) {
      // Refused by the engine (merged cells / out-of-range / delete-of-last).
      // Drop the snapshot so Undo doesn't restore to a state the failure
      // already left in place — mirrors the runTxn failure branch.
      session.undoStack.pop()
      warnOpFailed(
        'slides:table-structure',
        `engine refused ${o.kind} on ${o.sourceId} (likely merged cells or out-of-range)`,
      )
      return null
    }
    setSlidesDirty(session.path, true)
    const slide = buildWebRenderSlide(session.opened, session.fitWidthPx, o.slideIndex)
    return slide ? { slide, sourceId: r.elementId } : null
  })
  registerHandle('slides:replace-picture-bytes', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:replace-picture-bytes requires { slideIndex, sourceId, base64, ext }')
    }
    return commitSlide(
      event,
      'slides:replace-picture-bytes',
     () => ({
        op: 'replacePicture',
        target: { slide: o.slideIndex as number, el: o.sourceId },
        ...o,
      }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:apply-edit-script', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { ops?: unknown[] }
    if (!Array.isArray(o.ops) || o.ops.length === 0) {
      // This channel is the one exception: it declares `{ error: string }`, so
    // a structured failure is in-contract (the skill consumer reads `.error`).
    return { error: 'slides:apply-edit-script requires a non-empty { ops } array' }
    }
    const r = commit(
      event,
      'slides:apply-edit-script',
      () => o.ops as Op[])
    if (!r) return null
    const slideIndex = firstSlideIndex(o.ops as Op[])
    const slide = buildWebRenderSlide(r.session.opened, r.session.fitWidthPx, slideIndex)
    return slide ? { slide } : null
  })
  registerHandle('slides:apply-header-footer', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown>
    return commitAllSlides(
      event,
      'slides:apply-header-footer',
      () => ({ op: 'applyHeaderFooter', ...o }) as unknown as Op)
  })
  registerHandle('slides:apply-theme', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown>
    return commitAllSlides(
      event,
      'slides:apply-theme',
      () => ({ op: 'applyTheme', ...o }) as unknown as Op)
  })
  /* Contract: `{ count, slides } | null`. The count is the op's own
   * `after.count` — answering a hardcoded `{count: 0}` was how the stub made
   * Replace look like it matched nothing, so the renderer showed "0 replaced"
   * after a successful replace. */
  registerHandle('slides:find-replace', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown>
    const session = legacySession(event)
    if (!session) return null
    pushSlidesHistory(session)
    const r = runTxn(session.opened, {
      ops: [{ op: 'findReplace', ...o } as unknown as Op],
      isolation: 'atomic',
    })
    if (!r.applied) {
      session.undoStack.pop()
      // 0 matches is a normal outcome, not a failure — the renderer shows a
      // "not found" toast off this shape rather than an error.
      return { count: 0, slides: null }
    }
    setSlidesDirty(session.path, true)
    const count = (r.records?.[0]?.after as { count?: number } | undefined)?.count ?? 0
    return {
      count,
      slides: buildWebRenderSlides(session.opened, session.fitWidthPx),
    }
  })

  // ----- element set / link / transition -----------------------------------
  registerHandle('slides:set-advance-times', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { times?: Array<{ slideIndex: number; ms: number | null }> }
    if (!Array.isArray(o.times)) {
      return badArgs('slides:set-advance-times requires { times }')
    }
    return commitBool(
      event,
      'slides:set-advance-times',
      () =>
      o.times!.map((t) => ({
        op: 'setAdvanceTime',
        target: { slide: t.slideIndex },
        ms: t.ms,
      })) as unknown as Op[],
    )
  })
  registerHandle('slides:set-animations', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:set-animations requires { slideIndex, items }')
    }
    return commitBool(
      event,
      'slides:set-animations',
     () =>
        ({
          op: 'setAnimations',
          target: { slide: o.slideIndex as number },
          items: o.items,
        }) as unknown as Op,
    )
  })
  registerHandle('slides:set-hidden', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:set-hidden requires { slideIndex, hidden }')
    }
    return commitSlide(
      event,
      'slides:set-hidden',
     () =>
        ({
          op: 'setHidden',
          target: { slide: o.slideIndex as number },
          hidden: o.hidden,
        }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:set-link', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:set-link requires { slideIndex, sourceId, target }')
    }
    return commitSlide(
      event,
      'slides:set-link',
     () =>
        ({
          op: 'setLink',
          target: { slide: o.slideIndex as number, el: o.sourceId },
          link: o.target,
        }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:set-notes', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:set-notes requires { slideIndex, text }')
    }
    return commitBool(
      event,
      'slides:set-notes',
     () =>
        ({
          op: 'setNotes',
          target: { slide: o.slideIndex as number },
          text: o.text,
        }) as unknown as Op,
    )
  })
  registerHandle('slides:set-slide-layout', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:set-slide-layout requires { slideIndex }')
    }
    return commitSlide(
      event,
      'slides:set-slide-layout',
     () =>
        ({
          op: 'setSlideLayout',
          target: { slide: o.slideIndex as number },
          layoutPath: o.layoutPath,
        }) as unknown as Op,
      o.slideIndex,
    )
  })
  registerHandle('slides:set-slide-size', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { cx?: number; cy?: number }
    if (typeof o.cx !== 'number' || typeof o.cy !== 'number') {
      return badArgs('slides:set-slide-size requires { cx, cy }')
    }
    return commitAllSlides(
      event,
      'slides:set-slide-size',
      () => ({ op: 'setSlideSize', cx: o.cx, cy: o.cy }) as unknown as Op)
  })
  registerHandle('slides:set-transition', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as Record<string, unknown> & { slideIndex?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:set-transition requires { slideIndex, kind }')
    }
    return commitBool(
      event,
      'slides:set-transition',
     () =>
        ({
          op: 'setTransition',
          target: { slide: o.slideIndex as number },
          kind: o.kind,
        }) as unknown as Op,
    )
  })
  registerHandle('slides:get-transition', (event: unknown, slideIndex: unknown) => {
    const session = legacySession(event)
    if (!session || typeof slideIndex !== 'number') return { type: 'none', duration: 0 }
    const slide = session.opened.deck.slides[slideIndex]
    const tr = (slide as { transition?: { kind?: string; durationMs?: number } } | undefined)?.transition
    return {
      type: tr?.kind ?? 'none',
      duration: tr?.durationMs ?? 0,
    }
  })

  // ----- clipboard ops ------------------------------------------------------
  registerHandle('slides:copy-elements', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceIds?: string[] }
    const session = legacySession(event)
    // Contract: `Promise<number>` — the renderer tests `n > 0` before enabling
    // Paste. `{ok:true}` is not a number, so the comparison was always false.
    if (!session || typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) return 0
    const slide = session.opened.deck.slides[o.slideIndex]
    if (!slide) return 0
    const items = o.sourceIds
      .map((id) => slide.elements.find((el) => el.id === id))
      .filter((el): el is NonNullable<typeof el> => !!el)
      .map((el) => copyElementData(session.opened, slide, el))
    setSlidesElementClipboard(items)
    return items.length
  })
  registerHandle('slides:paste-elements', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; dxPx?: number; dyPx?: number; fitWidthPx?: number }
    if (typeof o.slideIndex !== 'number') {
      return badArgs('slides:paste-elements requires { slideIndex }')
    }
    return commitPasted(event, 'slides:paste-elements', o.slideIndex, (session) => {
      const items = getSlidesElementClipboard()
      if (!items.length) return null
      const toEmu = makeToEmu(session.opened, o.fitWidthPx ?? session.fitWidthPx)
      return { items, dx: toEmu(o.dxPx ?? 0), dy: toEmu(o.dyPx ?? 0) }
    })
  })
  registerHandle('slides:group-elements', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceIds?: string[] }
    if (typeof o.slideIndex !== 'number' || !Array.isArray(o.sourceIds)) {
      return badArgs('slides:group-elements requires { slideIndex, sourceIds }')
    }
    const session = legacySession(event)
    if (!session) {
      warnNoSession('slides:group-elements')
      return null
    }
    pushSlidesHistory(session)
    const r = runTxn(session.opened, {
      ops: [{ op: 'groupElements', target: { slide: o.slideIndex }, els: o.sourceIds }],
      isolation: 'atomic',
    })
    const groupId = r.applied ? r.records?.[0]?.created?.[0] : undefined
    if (!r.applied || !groupId) {
      session.undoStack.pop()
      warnOpFailed('slides:group-elements', r.failures?.[0]?.error ?? 'groupElements created no group')
      return null
    }
    setSlidesDirty(session.path, true)
    // Contract: `{ slide, groupId }` — the renderer selects the new group by
    // this id, so a fabricated `group-<now>` selected nothing.
    const slide = buildWebRenderSlide(session.opened, session.fitWidthPx, o.slideIndex)
    return slide ? { slide, groupId } : null
  })
  registerHandle('slides:ungroup-element', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return badArgs('slides:ungroup-element requires { slideIndex, sourceId }')
    }
    return commitSlide(
      event,
      'slides:ungroup-element',
     () => ({
        op: 'ungroupElement',
        target: { slide: o.slideIndex as number, el: o.sourceId },
      }),
      o.slideIndex,
    )
  })

  // ----- undo/redo ---------------------------------------------------------
  /* Contract: `RenderSlide[] | null` — the renderer replaces every page, since
   * a single edit can change deck-wide layout. `{ok:true}` here meant Undo
   * appeared to work while the deck never changed. */
  registerHandle('slides:undo', (event: unknown) => {
    const session = legacySession(event)
    if (!session) return null
    if (!undoSlidesHistory(session)) return null
    setSlidesDirty(session.path, true)
    return buildWebRenderSlides(session.opened, session.fitWidthPx)
  })
  registerHandle('slides:redo', (event: unknown) => {
    const session = legacySession(event)
    if (!session) return null
    if (!redoSlidesHistory(session)) return null
    setSlidesDirty(session.path, true)
    return buildWebRenderSlides(session.opened, session.fitWidthPx)
  })
  registerHandle('slides:history-batch-begin', (event: unknown) => {
    const session = legacySession(event)
    if (!session) return false
    beginSlidesHistoryBatch(session)
    return true
  })
  registerHandle('slides:history-batch-end', (event: unknown) => {
    const session = legacySession(event)
    if (!session) return null
    const before = endSlidesHistoryBatch(session)
    return before ? registerSlidesAiSnapshot(session, before) : null
  })
  registerHandle('slides:ai-snapshot-restore', (event: unknown, id: unknown) => {
    const session = legacySession(event)
    if (!session || typeof id !== 'number') return null
    if (!restoreSlidesAiSnapshot(session, id)) return null
    setSlidesDirty(session.path, true)
    return buildWebRenderSlides(session.opened, session.fitWidthPx)
  })

  // ----- presenter / display ----------------------------------------------
  for (const [channel, reason] of Object.entries(STUBBED_SLIDES_CHANNELS)) {
    registerHandle(channel, () => {
      // Keep the channel answerable (the renderer treats a rejected promise as
      // a hard failure) but say plainly that the server did nothing, so a
      // future reader does not mistake this for a working mutation.
      void reason
      return { ok: true, acknowledgedOnly: true }
    })
  }

  // ----- sections ----------------------------------------------------------
  /* Contract: `SectionInfo[] | null`. Sections live in presentation.xml, not on
   * a slide, so the ops are part-addressed through the section ops' own
   * resolvers; the response is always the full section list. */
  registerHandle('slides:set-sections', (event: unknown, sections: unknown) => {
    if (!Array.isArray(sections)) {
      return badArgs('slides:set-sections requires an array')
    }
    const r = commit(
      event,
      'slides:set-sections',
      () => ({ op: 'setSections', sections }) as unknown as Op)
    return r ? getSections(r.session.opened) : null
  })
  registerHandle('slides:add-section', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { atSlideIndex?: number; name?: string }
    const r = commit(
      event,
      'slides:add-section',
      () =>
      ({
        op: 'addSection',
        atSlideIndex: o.atSlideIndex,
        name: o.name,
      }) as unknown as Op,
    )
    return r ? getSections(r.session.opened) : null
  })
  registerHandle('slides:rename-section', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { id?: string; name?: string }
    const r = commit(
      event,
      'slides:rename-section',
      () => ({ op: 'renameSection', id: o.id, name: o.name }) as unknown as Op)
    return r ? getSections(r.session.opened) : null
  })
  registerHandle('slides:remove-section', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { id?: string }
    const r = commit(
      event,
      'slides:remove-section',
      () => ({ op: 'removeSection', id: o.id }) as unknown as Op)
    return r ? getSections(r.session.opened) : null
  })
  registerHandle('slides:move-section', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { id?: string; dir?: 'up' | 'down' }
    const r = commit(
      event,
      'slides:move-section',
      () => ({ op: 'moveSection', id: o.id, dir: o.dir }) as unknown as Op)
    // A whole section moving reorders the deck, so the renderer needs the full
    // slide set as well as the new section list.
    if (!r) return null
    return {
      slides: buildWebRenderSlides(r.session.opened, r.session.fitWidthPx),
      sections: getSections(r.session.opened),
    }
  })

  // ----- comments ----------------------------------------------------------
  /* Contract: `SlideComment[] | null` — the renderer replaces its comment list
   * with the response. Comments go through the executor like everything else,
   * so they share the undo stack and the dirty flag rather than being a second,
   * subtly-different edit path. A delete is located by (authorId, idx), which
   * is how the renderer identifies a comment (its `id` field).
   */
  registerHandle('slides:add-comment', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; text?: string; author?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.text !== 'string') {
      return badArgs('slides:add-comment requires { slideIndex, text }')
    }
    const r = commit(
      event,
      'slides:add-comment',
      () =>
      ({
        op: 'addComment',
        target: { slide: o.slideIndex as number },
        text: o.text,
        author: o.author ?? 'GenOffice',
      }) as unknown as Op,
    )
    if (!r) return null
    const slide = r.session.opened.deck.slides[o.slideIndex]
    return slide ? getSlideComments(r.session.opened.archive, slide.path) : null
  })
  registerHandle('slides:delete-comment', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; authorId?: number; idx?: number }
    if (
      typeof o.slideIndex !== 'number' ||
      typeof o.authorId !== 'number' ||
      typeof o.idx !== 'number'
    ) {
      return badArgs('slides:delete-comment requires { slideIndex, authorId, idx }')
    }
    const r = commit(
      event,
      'slides:delete-comment',
      () =>
      ({
        op: 'deleteComment',
        target: { slide: o.slideIndex as number },
        authorId: o.authorId,
        idx: o.idx,
      }) as unknown as Op,
    )
    if (!r) return null
    const slide = r.session.opened.deck.slides[o.slideIndex]
    return slide ? getSlideComments(r.session.opened.archive, slide.path) : null
  })

  // ----- per-element transactions -----------------------------------------
  // The full transaction executor from `@genoffice/pptx-ops` (`runTxn`) —
  // the same one the desktop main process drives from
  // `apps/slides/src/main/slides-main.ts:1485`. 58 op shapes are now
  // supported (addElement / setFill / setTransform / setFont / addChart /
  // addTable / setBackground / ...). Failures still surface as
  // `{ applied: false, failures: [...] }`; success returns the live
  // slide summary so it can refresh the renderer's slide panel.
  registerHandle('slides:apply-txn', async (_event: unknown, request: unknown) => {
    const req = (request || {}) as {
      path?: string
      ops?: unknown[]
      isolation?: 'atomic' | 'per_op'
    }
    const rawPath = typeof req.path === 'string' ? req.path : null
    if (!rawPath) {
      return {
        applied: false,
        failures: [{ index: 0, error: 'slides:apply-txn requires { path }' }],
      }
    }
    // Resolve storage://<backend>/<key> to the FILES_DIR canonical path so
    // the registry lookup matches what slides:open-path used to register
    // the session. Without this, a renderer that opens an upload (storage
    // URI) and then sends apply-txn ops gets a "no live model" failure
    // even though the open succeeded.
    const key = storageKeyFromPath(rawPath)
    const path = key ? join(FILES_DIR, key) : rawPath
    const session = getSlidesSession(path)
    if (!session) {
      return {
        applied: false,
        failures: [
          { index: 0, error: 'no live model for this path — call slides:open-path first' },
        ],
      }
    }
    const ops = Array.isArray(req.ops) ? req.ops : []
    if (ops.length === 0) {
      return { applied: true, ops: [], slides: slideSummary(session.opened) }
    }
    if (ops.length > 50) {
      return {
        applied: false,
        failures: [
          { index: 0, error: 'ops must be a non-empty array (at most 50 per transaction).' },
        ],
      }
    }
    const isolation = req.isolation === 'per_op' ? 'per_op' : 'atomic'
    // runTxn performs plan-then-execute with snapshot rollback. Atomic
    // isolation (default) restores the deck on any failure so the model
    // never carries a half-applied batch; per_op lets independent ops
    // succeed even when a sibling fails. The executor validates first
    // (dry-run) and only mutates on success — that's how the desktop
    // main process drives the same 58-op surface from
    // apps/slides/src/main/slides-main.ts:1485 without trusting renderer
    // input.
    const typedOps = ops as Op[]
    const plan = runTxn(session.opened, { ops: typedOps, isolation, dryRun: true })
    const invalid = plan.failures?.length ?? 0
    if (isolation === 'atomic' ? invalid > 0 : invalid >= ops.length) {
      return {
        applied: false,
        failures: (plan.failures ?? []).map((f) => ({ index: f.index, error: f.error })),
      }
    }
    pushSlidesHistory(session)
    const r = runTxn(session.opened, { ops: typedOps, isolation })
    const failures = (r.failures ?? []).map((f) => ({ index: f.index, error: f.error }))
    if (!r.applied) {
      session.undoStack.pop()
      return { applied: false, failures }
    }
    if ((r.records ?? []).length > 0) setSlidesDirty(path, true)
    return {
      applied: true,
      ...(failures.length > 0 ? { failures } : {}),
      slides: slideSummary(session.opened),
    }
  })

  function slideSummary(opened: OpenedPptx): Array<{ id: string; index: number }> {
    return opened.deck.slides.map((s, idx) => ({
      id: (s as { id?: string }).id ?? `slide-${idx}`,
      index: idx,
    }))
  }
}
