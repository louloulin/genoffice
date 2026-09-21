/**
 * Slides element-manipulation channels — add/edit/delete/transform/copy/paste
 * of slides, elements, charts, tables, text, ink, media, etc.
 *
 * Most handlers remain `{ ok: true }` placeholders because the full desktop
 * transaction executor lives in `apps/slides/src/main/slides-main.ts:1485`
 * and depends on Electron session state. The web build keeps a minimal
 * subset that mutates the in-memory `OpenedPptx` registry, just enough for
 * `slides:save` to serialise a meaningful deck. Unknown ops in
 * `slides:apply-txn` answer a structured failure rather than the previous
 * silently-accepted `{ ok: true }`, so a missing handler never no-ops a
 * renderer-side edit.
 */
import { registerHandle } from '../common/index'
import { getSlidesSession, setSlidesDirty } from './state'
import {
  insertBlankSlide,
  deleteSlide,
  setElementTextBodyProps,
  type OpenedPptx,
} from '@genoffice/pptx-engine'

export function registerSlidesElementHandlers(): void {
  // ----- slide-level mutations ---------------------------------------------
  registerHandle('slides:add-blank-slide', () => ({ ok: true, slideId: `slide-${Date.now()}` }))
  registerHandle('slides:add-slide', () => ({ ok: true, slideId: `slide-${Date.now()}` }))
  registerHandle('slides:add-slide-with-layout', () => ({ ok: true, slideId: `slide-${Date.now()}` }))
  registerHandle('slides:delete-slide', () => ({ ok: true }))
  registerHandle('slides:copy-slide', () => ({ ok: true, slideId: `slide-${Date.now()}` }))
  registerHandle('slides:paste-slide', () => ({ ok: true }))
  registerHandle('slides:repaste-slide', () => ({ ok: true }))
  registerHandle('slides:move-slide', () => ({ ok: true }))


  // ----- element add / edit / delete ---------------------------------------
  registerHandle('slides:add-chart', () => ({ ok: true, chartId: `chart-${Date.now()}` }))
  registerHandle('slides:add-image-bytes', () => ({ ok: true, imageId: `image-${Date.now()}` }))
  registerHandle('slides:add-table', () => ({ ok: true, tableId: `table-${Date.now()}` }))
  registerHandle('slides:add-text', () => ({ ok: true, elementId: `text-${Date.now()}` }))
  registerHandle('slides:add-element', () => ({ ok: true, elementId: `element-${Date.now()}` }))
  registerHandle('slides:add-media-bytes', () => ({ ok: true }))
  registerHandle('slides:add-ink', () => ({ ok: true }))
  registerHandle('slides:add-smartart', () => ({ ok: true }))

  registerHandle('slides:edit-text', () => ({ ok: true }))
  registerHandle('slides:edit-background', () => ({ ok: true }))
  registerHandle('slides:edit-chart', () => ({ ok: true }))
  registerHandle('slides:edit-connector-endpoints', () => ({ ok: true }))
  registerHandle('slides:edit-fill', () => ({ ok: true }))
  registerHandle('slides:edit-image-fill', () => ({ ok: true }))
  registerHandle('slides:edit-picture-opacity', () => ({ ok: true }))
  registerHandle('slides:edit-picture-src-rect', () => ({ ok: true }))
  registerHandle('slides:edit-stroke', () => ({ ok: true }))
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
  // The minimal but real transaction dispatcher. The desktop equivalent
  // (apps/slides/src/main/slides-main.ts:1485) runs every op through
  // `runTxn`, which knows ~50 op shapes; the web build wires only the
  // high-frequency ops the renderer uses today. Unknown ops return
  // `{ applied: false, failures: [...] }` so a missing handler never
  // silently no-ops a renderer-side edit.
  registerHandle('slides:apply-txn', async (_event: unknown, request: unknown) => {
    const req = (request || {}) as {
      path?: string
      ops?: Array<Record<string, unknown>>
    }
    const path = typeof req.path === 'string' ? req.path : null
    if (!path) {
      return {
        applied: false,
        failures: [{ index: 0, error: 'slides:apply-txn requires { path }' }],
      }
    }
    const session = getSlidesSession(path)
    if (!session) {
      return {
        applied: false,
        failures: [
          {
            index: 0,
            error: 'no live model for this path — call slides:open-path first',
          },
        ],
      }
    }
    const ops = Array.isArray(req.ops) ? req.ops : []
    if (ops.length === 0) {
      return { applied: true, ops: [], slides: slideSummary(session.opened) }
    }
    const failures: Array<{ index: number; error: string }> = []
    let anyApplied = false
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i]
      try {
        if (applyOneOp(session.opened, op)) {
          anyApplied = true
        } else {
          failures.push({
            index: i,
            error: `unsupported op '${String(op.op ?? '?')}' on web`,
          })
        }
      } catch (error) {
        failures.push({
          index: i,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (anyApplied) setSlidesDirty(path, true)
    return {
      applied: failures.length === 0,
      ...(failures.length > 0 ? { failures } : {}),
      slides: slideSummary(session.opened),
    }

  /** Real op dispatch: returns true if the op mutated the model. The desktop
   *  executor handles ~50 op shapes; this is the high-frequency subset
   *  needed for a render → save round-trip to land bytes on disk. */
  function applyOneOp(opened: OpenedPptx, op: Record<string, unknown>): boolean {
    const kind = String(op.op ?? '')
    switch (kind) {
      case 'addSlide': {
        const at = typeof op.at === 'number' ? op.at : opened.deck.slides.length
        insertBlankSlide(opened, at)
        return true
      }
      case 'deleteSlide': {
        const at = typeof op.at === 'number' ? op.at : 0
        return deleteSlide(opened, at)
      }
      case 'setText': {
        // The renderer's apply-txn ops carry the slide *index* in
        //  (a numeric position that drifts after delete/
        // duplicate ops). The pptx-engine setElementTextBodyProps takes
        // a slide reference + element id, so resolve index → Slide here
        // and trust the renderer to send a fresh op set after a
        // structural op. The text patch uses the minimal shape the
        // engine recognises for a single-run replacement.
        const target = op.target as { slide?: number; el?: string } | undefined
        const text = typeof op.text === 'string' ? op.text : ''
        if (!target || typeof target.slide !== 'number' || !target.el) return false
        const slide = opened.deck.slides[target.slide]
        if (!slide) return false
        setElementTextBodyProps(slide, target.el, { runs: [{ text }] } as never)
        return true
      }
      default:
        return false
    }
  }

  function slideSummary(
    opened: OpenedPptx,
  ): Array<{ id: string; index: number }> {
    return opened.deck.slides.map((s, idx) => ({
      id: (s as { id?: string }).id ?? `slide-${idx}`,
      index: idx,
    }))
  }
  })

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
