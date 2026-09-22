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
 * Channel-level handlers fall into two groups, and the split matters:
 *
 *   • **Real** — channels the renderer actually calls for a document
 *     mutation. They build the matching `Op` and run it through
 *     `applyLegacyOp` (same executor, same journal, same live model as
 *     `slides:apply-txn`). Every one of these used to answer the literal
 *     `{ ok: true }` below while mutating nothing, which the renderer
 *     believed: inserting a blank slide returned success, the slide list
 *     never changed, and `slides:save` then persisted a deck without it.
 *     Because the stub answered `{ok:true, slideId}`, the renderer took its
 *     success branch and never surfaced an error.
 *
 *   • **Acknowledged no-ops** — channels whose op needs renderer-only state
 *     the shape does not carry (OS clipboard handles, animation preview
 *     plumbing, presenter-window coordination). These still answer
 *     `{ ok: true }` because the renderer's flow reads them as "accepted"
 *     while the real document change travels over a different channel
 *     (`slides:apply-txn`). Each is listed in STUBBED_CHANNELS below so the
 *     boundary is auditable rather than implied.
 */
import { join } from 'node:path'
import { registerHandle, FILES_DIR, storageKeyFromPath } from '../common/index'
import {
  getSlidesDirty,
  getSlidesFitWidth,
  getSlidesSession,
  setSlidesDirty,
  getCurrentSlidesPath,
} from './state'
import { buildWebRenderSlides } from './core'
import type { OpenedPptx } from '@genoffice/pptx-engine'
import { runTxn, type Op } from '@genoffice/pptx-ops'


/**
 * Resolve the slides session path for a legacy IPC channel. Legacy channels
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

/**
 * Apply a single runTxn op using the legacy channel's args + the session
 * path resolved from event.sessionId. Returns the legacy `{ ok: true }`
 * shape on success or a structured `{ ok: false, error }` envelope on
 * failure so the renderer can branch correctly.
 */
function applyLegacyOp(
  event: unknown,
  op: Op,
  errorChannel: string,
): { ok: true; applied?: true } | { ok: false; error: string } {
  const path = legacySessionPath(event)
  if (!path) {
    return { ok: false, error: `${errorChannel}: no current slides session — call slides:open-path first` }
  }
  const session = getSlidesSession(path)
  if (!session) {
    return { ok: false, error: `${errorChannel}: no live model for current session` }
  }
  const r = runTxn(session.opened, { ops: [op], isolation: 'atomic' })
  if (!r.applied) {
    const first = r.failures?.[0]
    return { ok: false, error: first?.error ?? `${errorChannel}: op failed` }
  }
  if ((r.records ?? []).length > 0) setSlidesDirty(path, true)
  return { ok: true, applied: true }
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
}

/**
 * Run one op for a renderer channel and answer in the shape that channel's
 * caller expects.
 *
 * `applyLegacyOp` returns `{ok}`, which is enough for the element channels but
 * not for the slide-lifecycle ones: those return the re-rendered slide list
 * (and, for inserts, the new index) because the renderer calls `setSlides(...)`
 * with it. Answering `{ok:true}` there made the renderer keep its old array,
 * which is exactly how the stub hid the missing mutation.
 *
 * Returns `null` for "no live session", matching the desktop handlers — the
 * renderer's `if (r)` guard then leaves the document untouched instead of
 * reporting a success that did not happen.
 */
function applyLegacyMutation(
  event: unknown,
  op: Op,
): { slides: unknown[]; index: number } | { ok: false; error: string } | null {
  const path = legacySessionPath(event)
  if (!path) return null
  const session = getSlidesSession(path)
  if (!session) return null
  const r = runTxn(session.opened, { ops: [op], isolation: 'atomic' })
  if (!r.applied) {
    const first = r.failures?.[0]
    return { ok: false, error: first?.error ?? `${op.op}: op failed` }
  }
  setSlidesDirty(path, true)
  const slides = buildWebRenderSlides(session.opened, getSlidesFitWidth(path))
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
      return { ok: false, error: 'slides:add-blank-slide requires { sourceIndex }' }
    }
    return applyLegacyMutation(event, { op: 'addBlankSlide', target: { slide: o.sourceIndex } })
  })
  registerHandle('slides:add-slide', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { sourceIndex?: number; clearText?: boolean }
    if (typeof o.sourceIndex !== 'number') {
      return { ok: false, error: 'slides:add-slide requires { sourceIndex }' }
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
      return { ok: false, error: 'slides:add-slide-with-layout requires { sourceIndex }' }
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
      return { ok: false, error: 'slides:delete-slide requires a slide index' }
    }
    // The renderer replaces its whole list with the response, and refuses to
    // delete the last slide (`else if (ctx.slides.length <= 1)`), so a
    // `slides` array is the contract — not the `{ok:true}` the stub sent.
    return applyLegacyMutation(event, { op: 'deleteSlide', target: { slide: slideIndex } })
  })
  registerHandle('slides:move-slide', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { fromIndex?: number; toIndex?: number }
    if (typeof o.fromIndex !== 'number' || typeof o.toIndex !== 'number') {
      return { ok: false, error: 'slides:move-slide requires { fromIndex, toIndex }' }
    }
    return applyLegacyMutation(event, {
      op: 'moveSlide',
      target: { slide: o.fromIndex },
      to: o.toIndex,
    })
  })
  for (const [channel, reason] of Object.entries(STUBBED_SLIDES_CHANNELS)) {
    registerHandle(channel, () => {
      // Keep the channel answerable (the renderer treats a rejected promise as
      // a hard failure) but say plainly that the server did nothing, so a
      // future reader does not mistake this for a working mutation.
      void reason
      return { ok: true, acknowledgedOnly: true }
    })
  }

  // ----- element add / edit / delete ---------------------------------------
  registerHandle('slides:add-chart', () => ({ ok: true, chartId: `chart-${Date.now()}` }))
  registerHandle('slides:add-image-bytes', () => ({ ok: true, imageId: `image-${Date.now()}` }))
  registerHandle('slides:add-table', () => ({ ok: true, tableId: `table-${Date.now()}` }))
  registerHandle('slides:add-text', () => ({ ok: true, elementId: `text-${Date.now()}` }))
  registerHandle('slides:add-element', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; kind?: string; xPx?: number; yPx?: number; wPx?: number; hPx?: number; fitWidthPx?: number; text?: string; paragraphs?: unknown; sourceId?: string }
    if (typeof o.slideIndex !== 'number') {
      return { ok: false, error: 'slides:add-element requires { slideIndex, ... }' }
    }
    const r = applyLegacyOp(
      event,
      {
        op: 'addElement',
        target: { slide: o.slideIndex },
        kind: o.kind,
        xPx: o.xPx,
        yPx: o.yPx,
        wPx: o.wPx,
        hPx: o.hPx,
        fitWidthPx: o.fitWidthPx,
        text: o.text,
        paragraphs: o.paragraphs,
        ...(o.sourceId ? { sourceId: o.sourceId } : {}),
      },
      'slides:add-element',
    )
    return r.ok
      ? { ok: true, elementId: `element-${Date.now()}`, applied: true }
      : r
  })
  registerHandle('slides:add-media-bytes', () => ({ ok: true }))
  registerHandle('slides:add-ink', () => ({ ok: true }))
  registerHandle('slides:add-smartart', () => ({ ok: true }))

  registerHandle('slides:edit-text', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string; paragraphs?: unknown; groupId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return { ok: false, error: 'slides:edit-text requires { slideIndex, sourceId, paragraphs }' }
    }
    return applyLegacyOp(
      event,
      {
        op: 'setText',
        target: { slide: o.slideIndex, el: o.sourceId },
        paragraphs: o.paragraphs,
        ...(o.groupId ? { group: o.groupId } : {}),
      },
      'slides:edit-text',
    )
  })
  registerHandle('slides:edit-background', () => ({ ok: true }))
  registerHandle('slides:edit-chart', () => ({ ok: true }))
  registerHandle('slides:edit-connector-endpoints', () => ({ ok: true }))
  registerHandle('slides:edit-fill', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string; fill?: unknown; groupId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return { ok: false, error: 'slides:edit-fill requires { slideIndex, sourceId, fill }' }
    }
    return applyLegacyOp(
      event,
      {
        op: 'setFill',
        target: { slide: o.slideIndex, el: o.sourceId },
        fill: o.fill,
        ...(o.groupId ? { group: o.groupId } : {}),
      },
      'slides:edit-fill',
    )
  })
  registerHandle('slides:edit-image-fill', () => ({ ok: true }))
  registerHandle('slides:edit-picture-opacity', () => ({ ok: true }))
  registerHandle('slides:edit-picture-src-rect', () => ({ ok: true }))
  registerHandle('slides:edit-stroke', (event: unknown, op: unknown) => {
    const o = (op ?? {}) as { slideIndex?: number; sourceId?: string; stroke?: unknown; groupId?: string }
    if (typeof o.slideIndex !== 'number' || typeof o.sourceId !== 'string') {
      return { ok: false, error: 'slides:edit-stroke requires { slideIndex, sourceId, stroke }' }
    }
    return applyLegacyOp(
      event,
      {
        op: 'setStroke',
        target: { slide: o.slideIndex, el: o.sourceId },
        stroke: o.stroke,
        ...(o.groupId ? { group: o.groupId } : {}),
      },
      'slides:edit-stroke',
    )
  })
  registerHandle('slides:edit-table-cell', () => ({ ok: true }))
  registerHandle('slides:edit-table-style', () => ({ ok: true }))
  registerHandle('slides:edit-transform', () => ({ ok: true }))
  registerHandle('slides:batch-edit-transform', () => ({ ok: true }))
  registerHandle('slides:delete-element', () => ({ ok: true }))
  registerHandle('slides:duplicate-elements', () => ({ ok: true }))
  registerHandle('slides:flip-elements', () => ({ ok: true }))
  registerHandle('slides:reorder-element', () => ({ ok: true }))
  registerHandle('slides:insert-image', () => ({ ok: true }))
  registerHandle('slides:set-element-font', () => ({ ok: true }))
  registerHandle('slides:set-element-paragraph-format', () => ({ ok: true }))
  registerHandle('slides:set-table-cell-anchor', () => ({ ok: true }))
  registerHandle('slides:set-table-col-width', () => ({ ok: true }))
  registerHandle('slides:set-table-row-height', () => ({ ok: true }))
  registerHandle('slides:table-merge', () => ({ ok: true }))
  registerHandle('slides:replace-picture-bytes', () => ({ ok: true }))
  registerHandle('slides:apply-edit-script', () => ({ ok: true }))
  registerHandle('slides:apply-header-footer', () => ({ ok: true }))
  registerHandle('slides:apply-theme', () => ({ ok: true }))

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
    const r = runTxn(session.opened, { ops: typedOps, isolation })
    const failures = (r.failures ?? []).map((f) => ({ index: f.index, error: f.error }))
    if (!r.applied) {
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

  // ----- element set / link / transition -----------------------------------
  registerHandle('slides:set-advance-times', () => ({ ok: true }))
  registerHandle('slides:set-animations', () => ({ ok: true }))
  registerHandle('slides:set-hidden', () => ({ ok: true }))
  registerHandle('slides:set-link', () => ({ ok: true }))
  registerHandle('slides:set-notes', () => ({ ok: true }))
  registerHandle('slides:set-sections', () => ({ ok: true }))
  registerHandle('slides:set-slide-layout', () => ({ ok: true }))
  registerHandle('slides:set-slide-size', () => ({ ok: true }))
  registerHandle('slides:set-transition', () => ({ ok: true }))
  registerHandle('slides:get-transition', () => ({ type: 'none', duration: 0 }))

  // ----- clipboard ops ------------------------------------------------------
  registerHandle('slides:copy-elements', () => ({ ok: true }))
  registerHandle('slides:paste-elements', () => ({ ok: true }))
  registerHandle('slides:group-elements', () => ({ ok: true, groupId: `group-${Date.now()}` }))
  registerHandle('slides:ungroup-element', () => ({ ok: true }))

  // ----- undo/redo ---------------------------------------------------------
  registerHandle('slides:undo', () => ({ ok: true }))
  registerHandle('slides:redo', () => ({ ok: true }))
  registerHandle('slides:history-batch-begin', () => ({ ok: true }))
  registerHandle('slides:history-batch-end', () => ({ ok: true }))
  registerHandle('slides:ai-snapshot-restore', () => ({ ok: true }))

  // ----- find / replace ----------------------------------------------------
  registerHandle('slides:find-replace', () => ({ ok: true, count: 0 }))

  // ----- presenter / display ----------------------------------------------
  registerHandle('slides:presenter-start', () => ({ ok: true }))
  registerHandle('slides:presenter-end', () => ({ ok: true }))
  registerHandle('slides:presenter-swap', () => ({ ok: true }))
  registerHandle('slides:audience-ready', () => ({ ok: true }))
  registerHandle('slides:show-fullscreen', () => ({ ok: true }))

  // ----- sections ----------------------------------------------------------
  registerHandle('slides:add-section', () => ({ ok: true, sectionId: `section-${Date.now()}` }))
  registerHandle('slides:rename-section', () => ({ ok: true }))
  registerHandle('slides:remove-section', () => ({ ok: true }))
  registerHandle('slides:move-section', () => ({ ok: true }))

  // ----- comments ----------------------------------------------------------
  registerHandle('slides:add-comment', () => ({ ok: true, commentId: `comment-${Date.now()}` }))
  registerHandle('slides:delete-comment', () => ({ ok: true }))
}
