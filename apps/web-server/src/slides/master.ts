/**
 * Master-view edit channels (sdk1 §E.8 P1 #8, formerly closed in §A.5 #51
 * stubs).
 *
 * These used to answer a literal `{ ok: true }` while touching nothing. The
 * renderer side calls `applyCurrent(updated)` and treats any truthy value
 * as the re-rendered page (`if (updated) setItems(... { slide: updated })`),
 * so the truthy stub overwrote the master slide render with a `{ ok: true }`
 * object — the master view went blank on every edit, and downstream
 * selections/edits compounded from the corrupted state.
 *
 * The desktop main process drives the same surface in
 * `apps/slides/src/main/slides-main.ts:2548` with full OpTransaction logic.
 * The web build reuses the same engine primitives:
 *
 *   - `parseMasterPart(archive, partPath)` produces a live `Slide` model
 *     from a master/layout part (its spTree is isomorphic to a slide's, so
 *     the engine's scan/parse/serialize pipeline applies unchanged).
 *   - `runTxn(opened, { ops, parts: Map([[partPath, slide]]) })` is the
 *     same validated, atomic transaction engine that drives
 *     `slides:apply-txn`, now seeded with the master part so part-addressed
 *     ops resolve elements against the seeded object. The executor's
 *     `flushTouchedParts` re-serialises the seeded part to
 *     `archive.entries` and then re-materialises every deck slide so the
 *     inheritance chain picks up the chrome changes — the desktop relies
 *     on the same lifecycle.
 *   - `setSlidesDirty(path, true)` marks the deck dirty so `slides:save`
 *     will re-write the archive.
 *
 * History: we `pushSlidesHistory` before every committed master-edit op
 * (not before the dry-run), matching the desktop `sessionTxn` and giving
 * the renderer the same `slides:undo` / `slides:redo` semantics the slide
 * channels already use. `preview: true` (interactive drag) is excluded: a
 * drag pushes exactly one undo step at gesture end.
 *
 * Parse-time id stability: the seeded slide object is reused across edits
 * (held on `SlidesSessionInfo.masterEdit`), so element ids do not drift on
 * every `master-open` / `master-edit` cycle. This mirrors the §A.5 #7
 * fix for the outer deck and the desktop's own contract.
 */
import {
  buildRenderSlide,
  EMU_PER_PX_96,
} from '@genoffice/pptx-render'
import {
  listMasterParts,
  parseMasterPart,
  type OpenedPptx,
  type Slide,
} from '@genoffice/pptx-engine'
import {
  getCurrentSlidesPath,
  getSlidesSession,
  pushSlidesHistory,
  setSlidesDirty,
  setSlidesFitWidth,
  setSlidesMasterEdit,
  type SlidesSessionInfo,
} from './state'
import { makeWebMediaResolver, webMetrics } from './core'
import { runTxn } from '@genoffice/pptx-ops'
import { registerHandle } from '../common/index'

function badArgs(message: string): null {
  process.stderr.write(`[slides] ${message} (answering null)\n`)
  return null
}

function warnNoSession(channel: string): void {
  process.stderr.write(
    `[slides] ${channel}: no open deck for this session — the renderer must call slides:open-path first (answering null)\n`,
  )
}

function warnOpFailed(channel: string, reason: string): void {
  process.stderr.write(`[slides] ${channel}: ${reason} (answering null)\n`)
}

function resolveSession(event: unknown): SlidesSessionInfo | undefined {
  const sessionId = (event as { sessionId?: string } | null | undefined)?.sessionId
  const path = getCurrentSlidesPath(sessionId)
  return path ? getSlidesSession(path) : undefined
}

function renderMasterPart(opened: OpenedPptx, slide: Slide, fitWidthPx: number) {
  return buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx,
    media: makeWebMediaResolver(opened, slide.path),
    metrics: webMetrics,
  })
}

interface MasterCommitResult {
  readonly session: SlidesSessionInfo
  readonly rendered: ReturnType<typeof renderMasterPart>
}

/** Run one op against the master-edit target on `session`. Mirrors the
 *  `commit` helper in elements.ts but seeded with `parts: Map([[partPath,
 *  slide]])` so part-addressed ops resolve against the live master model.
 *  Returns the re-rendered master slide on success, null on failure. */
function commitMaster(
  event: unknown,
  channel: string,
  build: (session: SlidesSessionInfo, partPath: string) => Record<string, unknown> | null,
): MasterCommitResult | null {
  const session = resolveSession(event)
  if (!session) {
    warnNoSession(channel)
    return null
  }
  const me = session.masterEdit
  if (!me) {
    process.stderr.write(
      `[slides] ${channel}: no masterEdit target on this session — the renderer must call slides:master-open or slides:master-enter first (answering null)\n`,
    )
    return null
  }
  const op = build(session, me.partPath)
  if (!op) return null
  const parts = new Map<string, Slide>([[me.partPath, me.slide]])
  // dryRun: validate first so a failed op does not mutate the seeded slide
  // — the executor does not restore seeded parts on rollback (TxnRequest.parts
  // docstring is explicit).
  const plan = runTxn(session.opened, { ops: [op as never], parts, isolation: 'atomic', dryRun: true })
  const invalid = plan.failures?.length ?? 0
  if (invalid > 0) {
    warnOpFailed(channel, plan.failures?.[0]?.error ?? 'op failed')
    return null
  }
  pushSlidesHistory(session)
  const r = runTxn(session.opened, { ops: [op as never], parts, isolation: 'atomic' })
  if (!r.applied) {
    session.undoStack.pop()
    warnOpFailed(channel, r.failures?.[0]?.error ?? 'op failed')
    return null
  }
  setSlidesDirty(session.path, true)
  return {
    session,
    rendered: renderMasterPart(session.opened, me.slide, session.fitWidthPx),
  }
}

interface MasterPartRenderItem {
  readonly partPath: string
  readonly kind: 'master' | 'layout'
  readonly name: string
  readonly slide: ReturnType<typeof renderMasterPart>
}

function buildAllSlides(
  opened: OpenedPptx,
  fitWidthPx: number,
) {
  return opened.deck.slides.map((s: Slide, i: number) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeWebMediaResolver(opened, s.path),
      metrics: webMetrics,
      slideNo: i + 1,
    }),
  )
}

export function registerSlidesMasterHandlers(): void {
  // ── master-enter ─────────────────────────────────────────────────────────
  // Lists every master + layout part, parses each, builds a render for the
  // current edit target (items[0]). Binds `masterEdit` to that target so
  // subsequent master-edit-* ops resolve without an extra master-open call.
  registerHandle('slides:master-enter', (event: unknown, fitWidthPx: unknown) => {
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-enter')
      return null
    }
    if (typeof fitWidthPx === 'number' && fitWidthPx > 0) {
      setSlidesFitWidth(session.path, fitWidthPx)
    }
    const parts = listMasterParts(session.opened.archive)
    if (!parts.length) return null
    const firstPart = parts[0]!
    const editSlide = parseMasterPart(session.opened.archive, firstPart.partPath)
    if (!editSlide) return null
    setSlidesMasterEdit(session.path, { partPath: firstPart.partPath, slide: editSlide })

    const items: MasterPartRenderItem[] = parts.map((p, i) => {
      if (i === 0) {
        return {
          partPath: p.partPath,
          kind: p.kind,
          name: p.name,
          slide: renderMasterPart(session.opened, editSlide, session.fitWidthPx),
        }
      }
      const slide = parseMasterPart(session.opened.archive, p.partPath)
      if (!slide) return null
      return {
        partPath: p.partPath,
        kind: p.kind,
        name: p.name,
        slide: renderMasterPart(session.opened, slide, session.fitWidthPx),
      }
    }).filter((it): it is MasterPartRenderItem => it !== null)

    return { items }
  })

  // ── master-open ─────────────────────────────────────────────────────────
  // Re-parse the requested part (renderer-selected) and bind it as the edit
  // target. Returns the re-rendered master slide for the new target.
  registerHandle('slides:master-open', (event: unknown, partPath: unknown) => {
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-open')
      return null
    }
    if (typeof partPath !== 'string') {
      return badArgs('slides:master-open requires a string partPath')
    }
    const slide = parseMasterPart(session.opened.archive, partPath)
    if (!slide) return badArgs(`slides:master-open: cannot parse part "${partPath}"`)
    setSlidesMasterEdit(session.path, { partPath, slide })
    return renderMasterPart(session.opened, slide, session.fitWidthPx)
  })

  // ── master-close ────────────────────────────────────────────────────────
  // Drop the edit target, then re-render every deck slide so inheritance
  // picks up the chrome changes the master-edit-* ops already wrote to
  // `archive.entries`. Mirrors the desktop handler that returns
  // `buildAllRenderSlides(session.opened, session.fitWidthPx)`.
  registerHandle('slides:master-close', (event: unknown) => {
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-close')
      return null
    }
    setSlidesMasterEdit(session.path, undefined)
    return buildAllSlides(session.opened, session.fitWidthPx)
  })

  // ── master-edit-text ────────────────────────────────────────────────────
  registerHandle('slides:master-edit-text', (event: unknown, op: unknown) => {
    const req = op as { sourceId?: unknown; paragraphs?: unknown } | null | undefined
    if (!req || typeof req.sourceId !== 'string' || !Array.isArray(req.paragraphs)) {
      return badArgs('slides:master-edit-text requires { sourceId, paragraphs[] }')
    }
    const r = commitMaster(event, 'slides:master-edit-text', (session, partPath) => ({
      op: 'setText',
      target: { part: partPath, el: req.sourceId },
      paragraphs: req.paragraphs,
    }))
    return r?.rendered ?? null
  })

  // ── master-edit-transform ───────────────────────────────────────────────
  // Convert px → EMU at the current viewport. `preview: true` mutates the
  // live master slide but skips `runTxn` flush — the desktop pushes the
  // history step exactly once per drag gesture.
  registerHandle('slides:master-edit-transform', (event: unknown, op: unknown) => {
    const req = op as {
      sourceId?: unknown
      xPx?: unknown
      yPx?: unknown
      wPx?: unknown
      hPx?: unknown
      rotationDeg?: unknown
      fitWidthPx?: unknown
      preview?: unknown
    } | null | undefined
    if (
      !req ||
      typeof req.sourceId !== 'string' ||
      typeof req.xPx !== 'number' ||
      typeof req.yPx !== 'number' ||
      typeof req.wPx !== 'number' ||
      typeof req.hPx !== 'number' ||
      typeof req.rotationDeg !== 'number'
    ) {
      return badArgs('slides:master-edit-transform requires numeric { xPx, yPx, wPx, hPx, rotationDeg }')
    }
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-edit-transform')
      return null
    }
    const me = session.masterEdit
    if (!me) {
      process.stderr.write(
        '[slides] slides:master-edit-transform: no masterEdit target on this session (answering null)\n',
      )
      return null
    }
    const baseWidthPx = session.opened.deck.size.cx / EMU_PER_PX_96
    const fitWidthPx =
      typeof req.fitWidthPx === 'number' && req.fitWidthPx > 0
        ? req.fitWidthPx
        : session.fitWidthPx
    const scale = fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const x = toEmu(req.xPx)
    const y = toEmu(req.yPx)
    const cx = toEmu(req.wPx)
    const cy = toEmu(req.hPx)
    const rotDeg = req.rotationDeg
    if (req.preview === true) {
      const el = me.slide.elements.find((e) => e.id === req.sourceId)
      if (!el) return null
      el.transform = {
        ...el.transform,
        offset: { x, y, cx, cy },
        rot: Math.round(rotDeg * 60000),
      }
      el.dirtyTransform = true
      return renderMasterPart(session.opened, me.slide, session.fitWidthPx)
    }
    const r = commitMaster(event, 'slides:master-edit-transform', (_session, partPath) => ({
      op: 'setTransform',
      target: { part: partPath, el: req.sourceId },
      box: { x, y, cx, cy },
      rotDeg,
    }))
    return r?.rendered ?? null
  })

  // ── master-edit-fill ────────────────────────────────────────────────────
  registerHandle('slides:master-edit-fill', (event: unknown, op: unknown) => {
    const req = op as { sourceId?: unknown; fill?: unknown } | null | undefined
    if (
      !req ||
      typeof req.sourceId !== 'string' ||
      (typeof req.fill !== 'string' && (typeof req.fill !== 'object' || req.fill === null))
    ) {
      return badArgs('slides:master-edit-fill requires { sourceId, fill }')
    }
    const r = commitMaster(event, 'slides:master-edit-fill', (_session, partPath) => ({
      op: 'setFill',
      target: { part: partPath, el: req.sourceId },
      fill: req.fill,
    }))
    return r?.rendered ?? null
  })

  // ── master-edit-stroke ──────────────────────────────────────────────────
  // Renderer's stroke spec is `{ color: '#RRGGBB', widthPt: N }` or `null`;
  // the engine's `setStroke` expects `{ color, widthEmu }` (or null). Convert
  // once here so the IPC contract matches the desktop signature.
  registerHandle('slides:master-edit-stroke', (event: unknown, op: unknown) => {
    if (!op || typeof op !== 'object') {
      return badArgs('slides:master-edit-stroke requires { sourceId, stroke: {color, widthPt} | null }')
    }
    const o = op as { sourceId?: unknown; stroke?: unknown }
    if (typeof o.sourceId !== 'string') {
      return badArgs('slides:master-edit-stroke requires a string sourceId')
    }
    const sourceId = o.sourceId
    const strokeRaw = o.stroke
    if (strokeRaw !== null && strokeRaw !== undefined) {
      if (
        typeof strokeRaw !== 'object' ||
        typeof (strokeRaw as { color?: unknown }).color !== 'string' ||
        typeof (strokeRaw as { widthPt?: unknown }).widthPt !== 'number'
      ) {
        return badArgs(
          'slides:master-edit-stroke requires stroke: {color, widthPt} | null',
        )
      }
    }
    const r = commitMaster(event, 'slides:master-edit-stroke', (_session, partPath) => ({
      op: 'setStroke',
      target: { part: partPath, el: sourceId },
      stroke:
        strokeRaw === null || strokeRaw === undefined
          ? null
          : {
              color: (strokeRaw as { color: string }).color,
              widthEmu: Math.round(
                (strokeRaw as { widthPt: number }).widthPt * EMU_PER_PX_96,
              ),
            },
    }))
    return r?.rendered ?? null
  })

  // ── master-delete-element ───────────────────────────────────────────────
  registerHandle('slides:master-delete-element', (event: unknown, op: unknown) => {
    const req = op as { sourceId?: unknown } | null | undefined
    if (!req || typeof req.sourceId !== 'string') {
      return badArgs('slides:master-delete-element requires { sourceId }')
    }
    const r = commitMaster(event, 'slides:master-delete-element', (_session, partPath) => ({
      op: 'deleteElement',
      target: { part: partPath, el: req.sourceId },
    }))
    return r?.rendered ?? null
  })
}
