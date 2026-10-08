/**
 * Master-view edit channels — the master / layout editing surface.
 *
 * Port of `apps/web-server/src/slides/master.ts`. The desktop main process
 * drives the same surface in `apps/slides/src/main/slides-main.ts` with full
 * OpTransaction logic; this port reuses the same engine primitives:
 *
 *   - `parseMasterPart(archive, partPath)` produces a live `Slide` model from a
 *     master/layout part (its spTree is isomorphic to a slide's, so the
 *     engine's scan/parse/serialize pipeline applies unchanged).
 *   - `runTxn(opened, { ops, parts: Map([[partPath, slide]]) })` is the same
 *     validated, atomic transaction engine that drives `slides:apply-txn`, now
 *     seeded with the master part so part-addressed ops resolve elements
 *     against the seeded object. The executor's `flushTouchedParts`
 *     re-serialises the seeded part to `archive.entries` and then
 *     re-materialises every deck slide so the inheritance chain picks up the
 *     chrome changes.
 *
 * History is pushed before every committed master-edit op (never before the
 * dry-run), so `slides:undo` / `slides:redo` behave exactly as they do for
 * deck slides. `preview: true` (interactive drag) is excluded: a drag pushes
 * one undo step at gesture end.
 *
 * Parse-time id stability: the seeded slide object is reused across edits (held
 * on `SlidesSessionInfo.masterEdit`), so element ids do not drift on every
 * `master-open` / `master-edit` cycle.
 */
import { runTxn } from '@genoffice/pptx-ops'
import { listMasterParts, parseMasterPart, type OpenedPptx, type Slide } from '@genoffice/pptx-engine'
import { EMU_PER_PX_96 } from '@genoffice/pptx-render'
import type { Registry } from '../../registry'
import { buildRenderSlideModel, buildRenderSlides } from './core'
import {
  pushSlidesHistory,
  rollbackSlidesHistory,
  type SlidesSessionInfo,
  type SlidesState,
} from './state'

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

export function registerSlidesMasterHandlers(registry: Registry, state: SlidesState): void {
  const resolveSession = (event: unknown): SlidesSessionInfo | undefined => {
    const sessionId = (event as { sessionId?: string } | null | undefined)?.sessionId
    const path = state.getCurrentPath(sessionId)
    return path ? state.getSession(path) : undefined
  }

  const renderMasterPart = (opened: OpenedPptx, slide: Slide, fitWidthPx: number) =>
    buildRenderSlideModel(opened, slide, fitWidthPx)

  interface MasterCommitResult {
    readonly session: SlidesSessionInfo
    readonly rendered: ReturnType<typeof renderMasterPart>
  }

  /** Run one op against the master-edit target on `session`, seeded with
   *  `parts: Map([[partPath, slide]])` so part-addressed ops resolve against
   *  the live master model. Returns the re-rendered master, or null. */
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
    // dryRun first so a failed op does not mutate the seeded slide — the
    // executor does not restore seeded parts on rollback (TxnRequest.parts
    // is explicit about that).
    const plan = runTxn(session.opened, {
      ops: [op as never],
      parts,
      isolation: 'atomic',
      dryRun: true,
    })
    if ((plan.failures?.length ?? 0) > 0) {
      warnOpFailed(channel, plan.failures?.[0]?.error ?? 'op failed')
      return null
    }
    const redoDepth = pushSlidesHistory(session, event)
    const r = runTxn(session.opened, { ops: [op as never], parts, isolation: 'atomic' })
    if (!r.applied) {
      rollbackSlidesHistory(session, redoDepth, event)
      warnOpFailed(channel, r.failures?.[0]?.error ?? 'op failed')
      return null
    }
    state.setDirty(session.path, true)
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

  registry.registerHandle('slides:master-enter', (event: unknown, fitWidthPx: unknown) => {
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-enter')
      return null
    }
    if (typeof fitWidthPx === 'number' && fitWidthPx > 0) {
      state.setFitWidth(session.path, fitWidthPx)
    }
    const parts = listMasterParts(session.opened.archive)
    if (!parts.length) return null
    const firstPart = parts[0]!
    const editSlide = parseMasterPart(session.opened.archive, firstPart.partPath)
    if (!editSlide) return null
    state.setMasterEdit(session.path, { partPath: firstPart.partPath, slide: editSlide })

    // items[0] renders the SHARED edit model rather than a second parse of the
    // same part: the renderer edits elements by the ids it sees on items[0],
    // and a re-parsed copy would have freshly-minted ids that match nothing.
    const items: MasterPartRenderItem[] = parts
      .map((p, i) => {
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
      })
      .filter((it): it is MasterPartRenderItem => it !== null)

    return { items }
  })

  registry.registerHandle('slides:master-open', (event: unknown, partPath: unknown) => {
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
    state.setMasterEdit(session.path, { partPath, slide })
    return renderMasterPart(session.opened, slide, session.fitWidthPx)
  })

  // Drop the edit target, then re-render every deck slide so inheritance picks
  // up the chrome changes the master-edit-* ops already wrote to archive.entries.
  registry.registerHandle('slides:master-close', (event: unknown) => {
    const session = resolveSession(event)
    if (!session) {
      warnNoSession('slides:master-close')
      return null
    }
    state.setMasterEdit(session.path, undefined)
    return buildRenderSlides(session.opened, session.fitWidthPx)
  })

  registry.registerHandle('slides:master-edit-text', (event: unknown, op: unknown) => {
    const req = op as { sourceId?: unknown; paragraphs?: unknown } | null | undefined
    if (!req || typeof req.sourceId !== 'string' || !Array.isArray(req.paragraphs)) {
      return badArgs('slides:master-edit-text requires { sourceId, paragraphs[] }')
    }
    const r = commitMaster(event, 'slides:master-edit-text', (_session, partPath) => ({
      op: 'setText',
      target: { part: partPath, el: req.sourceId },
      paragraphs: req.paragraphs,
    }))
    return r?.rendered ?? null
  })

  registry.registerHandle('slides:master-edit-transform', (event: unknown, op: unknown) => {
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
      return badArgs(
        'slides:master-edit-transform requires numeric { xPx, yPx, wPx, hPx, rotationDeg }',
      )
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
      typeof req.fitWidthPx === 'number' && req.fitWidthPx > 0 ? req.fitWidthPx : session.fitWidthPx
    const scale = fitWidthPx / baseWidthPx
    const toEmu = (px: number) => Math.round((px / scale) * EMU_PER_PX_96)
    const x = toEmu(req.xPx)
    const y = toEmu(req.yPx)
    const cx = toEmu(req.wPx)
    const cy = toEmu(req.hPx)
    const rotDeg = req.rotationDeg
    // An interactive drag mutates the live model in place and skips runTxn's
    // flush; the desktop pushes its one history step at gesture end (the
    // non-preview call below).
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

  registry.registerHandle('slides:master-edit-fill', (event: unknown, op: unknown) => {
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

  // The renderer's stroke spec is `{ color: '#RRGGBB', widthPt: N }` or null;
  // the engine's setStroke expects `{ color, widthEmu }`. Convert once here.
  registry.registerHandle('slides:master-edit-stroke', (event: unknown, op: unknown) => {
    if (!op || typeof op !== 'object') {
      return badArgs(
        'slides:master-edit-stroke requires { sourceId, stroke: {color, widthPt} | null }',
      )
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
        return badArgs('slides:master-edit-stroke requires stroke: {color, widthPt} | null')
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
              widthEmu: Math.round((strokeRaw as { widthPt: number }).widthPt * EMU_PER_PX_96),
            },
    }))
    return r?.rendered ?? null
  })

  registry.registerHandle('slides:master-delete-element', (event: unknown, op: unknown) => {
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