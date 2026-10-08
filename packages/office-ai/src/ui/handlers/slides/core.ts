/**
 * Core slides lifecycle channels — new-blank, open, open-path, save, save-as,
 * export-images, consume-pending-open, font-download/install, insert-model3d.
 *
 * Port of `apps/web-server/src/slides/core.ts`. What the library drops relative
 * to web-server:
 *  - the `slides-recent.json` list and the unified recents store — a library has
 *    no home grid and no history to show; the caller owns file history;
 *  - the pluggable storage backend and its `storage://<backend>/<key>` URIs —
 *    every path here is a real filesystem path inside the host workspace;
 *  - webhooks and version-history snapshots — operational surfaces a single
 *    in-process editor has no consumer for.
 *
 * What it keeps, and why it matters: the *live model*. The renderer streams
 * `slides:apply-txn` ops and those mutate the registered `OpenedPptx` in place;
 * `slides:save` serialises that model back to a pptx. That is the whole edit
 * loop — without it every edit acknowledged success and the save threw the
 * bytes away.
 */
import { basename, resolve, sep } from 'node:path'

import { createBlankPptx, openPptx, parseTheme, savePptxToFile } from '@genoffice/pptx-engine'
import type { OpenedPptx, Slide } from '@genoffice/pptx-engine'
import { buildRenderSlide, HeuristicMetrics } from '@genoffice/pptx-render'

import { OfficeError } from '../../../errors'
import type { Registry } from '../../registry'
import { fileSize, safeFileStem, type Workspace } from '../../workspace'
import { displayMime, neutralizeJpegOrientation, tiffToPng } from './media'
import type { SlidesState } from './state'

function bytesFrom(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

/** Pull the deck's minor (body) Latin font from theme1.xml so the ribbon font
 *  box has something meaningful even before the user picks a selection. */
function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}

/** Media resolver shared by the render builders. Chromium cannot decode TIFF
 *  and applies EXIF orientation that PowerPoint ignores, so both are corrected
 *  at serve time; the package keeps the original bytes. */
function makeMediaResolver(opened: OpenedPptx): (mediaRef: string) => string | undefined {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    const bytes = opened.archive.readBytes(mediaRef)
    let url: string | undefined
    if (bytes) {
      const mime = displayMime(mediaRef, bytes)
      if (mime === 'image/tiff') {
        const decoded = tiffToPng(bytes)
        if (decoded) url = `data:image/png;base64,${Buffer.from(decoded.png).toString('base64')}`
      } else {
        const served = mime === 'image/jpeg' ? neutralizeJpegOrientation(bytes) : bytes
        url = `data:${mime};base64,${Buffer.from(served).toString('base64')}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}

/** Deterministic heuristic metrics (no font parsing). Matches the desktop
 *  fallback when `createSystemFontMetrics` hasn't initialised. */
export const renderMetrics = new HeuristicMetrics()

/** Default slide canvas width used when the renderer doesn't pass `fitWidthPx`. */
const DEFAULT_FIT_WIDTH = 1280

export function buildRenderSlides(opened: OpenedPptx, fitWidthPx: number) {
  return opened.deck.slides.map((s: Slide, i: number) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeMediaResolver(opened),
      metrics: renderMetrics,
      slideNo: i + 1,
    }),
  )
}

/**
 * Render exactly one page. The element channels answer `RenderSlide | null` and
 * the renderer feeds that straight into `applySlide(index, slide)`, so
 * rebuilding the whole deck per edit would be wasted work on a large file.
 *
 * `slideNo` is still `index + 1` (not omitted): a slide-number placeholder in
 * the page content must render the same value a full rebuild would produce, or
 * a single-page edit would silently renumber the page.
 */
export function buildOneRenderSlide(
  opened: OpenedPptx,
  fitWidthPx: number,
  index: number,
): ReturnType<typeof buildRenderSlides>[number] | null {
  const s = opened.deck.slides[index]
  if (!s) return null
  return buildRenderSlide(s, opened.deck.size, {
    fitWidthPx,
    media: makeMediaResolver(opened),
    metrics: renderMetrics,
    slideNo: index + 1,
  })
}

/**
 * Render an arbitrary slide-like model (a master or layout part parsed out of
 * the archive), not a deck page. Master-view edits answer a re-rendered
 * master, so they need the same media/metrics pipeline as a deck page but
 * without a deck index.
 */
export function buildRenderSlideModel(
  opened: OpenedPptx,
  slide: Slide,
  fitWidthPx: number,
  slideNo?: number,
) {
  return buildRenderSlide(slide, opened.deck.size, {
    fitWidthPx,
    media: makeMediaResolver(opened),
    metrics: renderMetrics,
    ...(typeof slideNo === 'number' ? { slideNo } : {}),
  })
}

/** Emit an SSE event to the renderer's session (`event.sender.send`). */
function emit(event: unknown, channel: string, ...args: unknown[]): void {
  const sender = (
    event as { sender?: { send?: (channel: string, ...args: unknown[]) => void } } | undefined
  )?.sender
  sender?.send?.(channel, ...args)
}

function sessionIdOf(event: unknown): string | undefined {
  return (event as { sessionId?: string } | null)?.sessionId
}

export function registerSlidesCoreHandlers(
  registry: Registry,
  workspace: Workspace,
  state: SlidesState,
): void {
  const requirePath = (channel: string, filePath: unknown): string => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: path must be a non-empty string`)
    }
    const resolved = workspace.resolvePath(filePath)
    if (!resolved) {
      throw new OfficeError('OFFICE_BAD_INPUT', `path is outside the office-ai workspace: ${filePath}`)
    }
    return resolved
  }

  /** Save targets must be .pptx inside the workspace — the same confinement the
   *  read path enforces, so a renderer cannot name an arbitrary path. */
  const requirePptxTarget = (channel: string, filePath: unknown): string => {
    const resolved = requirePath(channel, filePath)
    if (!/\.pptx$/i.test(resolved)) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: target must be a .pptx file`)
    }
    return resolved
  }

  registry.registerHandle('slides:new-blank', async (event, options: unknown) => {
    const opts = (options ?? {}) as { pptx?: ArrayBuffer; path?: string; fitWidthPx?: unknown }
    let path: string
    const provided = opts.pptx === undefined ? null : bytesFrom(opts.pptx)
    if (provided?.byteLength) {
      path = workspace.stageBytes('presentation.pptx', provided)
    } else if (typeof opts.path === 'string' && opts.path) {
      /* Caller supplied a path but no bytes (it already wrote the file via a
       * different channel). Trust the path; do not overwrite. */
      path = requirePath('slides:new-blank', opts.path)
    } else {
      /* No bytes, no path: the renderer fired the channel from its boot
       * "give me a blank deck" path. Materialise a real, openable deck so the
       * file the renderer is about to save into actually exists. */
      path = workspace.stageBytes('presentation.pptx', await createBlankPptx())
    }

    const fitWidthPx =
      typeof opts.fitWidthPx === 'number' && Number.isFinite(opts.fitWidthPx) && opts.fitWidthPx > 0
        ? opts.fitWidthPx
        : DEFAULT_FIT_WIDTH
    const opened = await openPptx(new Uint8Array(workspace.readBytes(path)), {
      useHashBasedIds: true,
    })
    state.registerSession(path, opened, fitWidthPx)
    state.setCurrentPath(sessionIdOf(event), path)
    return {
      path,
      slides: buildRenderSlides(opened, fitWidthPx),
      size: opened.deck.size,
      defaultFont: deckDefaultFont(opened),
    }
  })

  registry.registerHandle('slides:open', async (_event, options: unknown) => {
    const opts = (options ?? {}) as { path?: string }
    const path = typeof opts.path === 'string' ? opts.path : ''
    return { id: `slide-${Date.now()}`, path, name: path ? basename(path) : '' }
  })

  registry.registerHandle('slides:open-path', async (event, filePath: unknown, fitWidthArg: unknown) => {
    // A non-string `filePath` is a renderer-side mistake (the channel contract
    // is "string path"), not a missing resource. 400 keeps the failure mode
    // consistent with `docs:open-path` / `workbook:open-path`.
    if (typeof filePath !== 'string') {
      throw new OfficeError('OFFICE_BAD_INPUT', 'slides:open-path: path must be a string')
    }
    const path = requirePath('slides:open-path', filePath)
    let bytes: Buffer
    try {
      bytes = Buffer.from(workspace.readBytes(path))
    } catch (error) {
      throw new OfficeError('OFFICE_NOT_FOUND', `File not found: ${path}`, { cause: String(error) })
    }
    const name = basename(path)

    /* The renderer passes its canvas width on open; remembering it here means
     * the slide-lifecycle channels re-render at the same width. Rebuilding at
     * a different width would make every slide resize on the next insert. */
    const fitWidthPx =
      typeof fitWidthArg === 'number' && Number.isFinite(fitWidthArg) && fitWidthArg > 0
        ? fitWidthArg
        : DEFAULT_FIT_WIDTH

    /* Parse-time element ids are assigned per parse and are NOT stable: parsing
     * the same bytes twice yields `sp_0` then `sp_2`. The renderer holds ids
     * from whatever parse produced its current tree, so a second parse of the
     * same file would hand it a model whose ids match nothing it is holding —
     * every id-addressed channel (`group-elements`, `delete-element`,
     * `edit-transform`) would then answer `null` for elements the user can see.
     *
     * So a re-open of a path that is ALREADY live reuses that model. The file
     * bytes are still read (and still fail loudly if the file is unreadable),
     * but they only seed a model the first time. */
    const live = state.getSession(path)
    if (live) {
      state.setFitWidth(path, fitWidthPx)
      state.setCurrentPath(sessionIdOf(event), path)
      return {
        path,
        name,
        slides: buildRenderSlides(live.opened, fitWidthPx),
        size: live.opened.deck.size,
        defaultFont: deckDefaultFont(live.opened),
      }
    }

    let opened: OpenedPptx
    try {
      // useHashBasedIds: each element's id is sha1(fragment bytes), so the same
      // XML fragment keeps its id even when shapes are inserted around it. The
      // previous counter scheme shifted every later id by one when the user
      // inserted a shape between two existing ones — stale selections then
      // pointed at nothing and every id-addressed channel answered `null` for
      // elements the user could still see. The renderer treats id as opaque.
      opened = await openPptx(new Uint8Array(bytes), { useHashBasedIds: true })
    } catch (error) {
      throw new OfficeError(
        'OFFICE_BAD_INPUT',
        `Failed to parse deck: ${error instanceof Error ? error.message : String(error)}`,
        { cause: String(error) },
      )
    }

    // Register the live model so `slides:save` and `slides:apply-txn` have
    // something to mutate. `path` (the renderer-visible path) is the registry
    // key, so a renderer that re-opens the same logical file after a save-as
    // sees the new model rather than a stale one.
    state.registerSession(path, opened, fitWidthPx)
    // Record the active deck against the SSE session id so legacy channels
    // (save / apply-txn / edit-text / edit-fill / add-element) find the session
    // without the renderer repeating the path on every call.
    state.setCurrentPath(sessionIdOf(event), path)

    return {
      path,
      name,
      slides: buildRenderSlides(opened, fitWidthPx),
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  })

  // ── Save ───────────────────────────────────────────────────────────────
  registry.registerHandle(
    'slides:save',
    async (event, _id?: unknown, path?: unknown, data?: unknown) => {
      // The session binding decides what gets written. The renderer's
      // `save()` sends no arguments at all, so nothing legitimate is lost by
      // dropping the preference for a renderer-supplied path — and preferring
      // it let any client name another client's deck, overwrite it on disk and
      // clear its dirty flag. A path that *is* supplied is accepted only as an
      // echo: it must match the deck this session opened.
      const resolvedPath = state.getCurrentPath(sessionIdOf(event))
      if (typeof path === 'string' && path && path !== resolvedPath) {
        return {
          ok: false,
          error: 'slides:save: path does not match the deck open in this session',
        }
      }
      if (!resolvedPath) {
        /* No path AND no open-path session: there is nothing to serialise. The
         * renderer reads `ok:false` + `canceled:true` as "this build cannot
         * save", which matches the copy on the save button. */
        return {
          ok: false,
          canceled: true,
          error: 'slides:save: no open deck for this session — call slides:open-path first',
        }
      }

      let target: string
      try {
        target = requirePptxTarget('slides:save', resolvedPath)
      } catch (error) {
        return {
          ok: false,
          error: error instanceof OfficeError ? error.message : String(error),
        }
      }

      // Two valid save flows:
      //   1. The renderer hands over pptx bytes (`data` is an ArrayBuffer /
      //      Uint8Array). Write them straight through.
      //   2. The renderer passes no bytes. Serialise the registered
      //      `OpenedPptx` via `savePptxToFile` — this is the only path that
      //      round-trips a deck whose edits the renderer streamed through
      //      `slides:apply-txn`.
      try {
        const provided = data === undefined || data === null ? null : bytesFrom(data)
        if (data !== undefined && data !== null) {
          if (!provided || provided.byteLength === 0) {
            return { ok: false, error: 'save data is empty or invalid' }
          }
          workspace.writeBytes(target, provided)
        } else {
          const session = state.getSession(target)
          if (!session) {
            return {
              ok: false,
              canceled: true,
              error: 'slides:save: no live model for this path — re-open the deck first',
            }
          }
          await savePptxToFile(session.opened, target)
        }

        /* Clear the dirty flag: the on-disk bytes now match the model.
         *
         * Deliberately NO reparse here. Parse-time element ids are assigned
         * per parse and are NOT stable — parsing the same bytes twice yields
         * different ids, which is why the op layer also accepts the durable
         * `e_<guid8>` form. A reparse would hand the renderer a model whose
         * ids do not match the ones it is holding, and every id-addressed
         * channel after a save would start answering `null` for elements the
         * user can see on screen. Keeping the live model is what keeps ids
         * stable across a save. */
        state.setDirty(target, false)

        let size = 0
        try {
          size = fileSize(target)
        } catch {
          /* missing file is unexpected here, swallow */
        }
        emit(event, 'saved', { path: target, version: Date.now(), bytes: size, format: 'pptx' })
        return { ok: true, path: target }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  registry.registerHandle(
    'slides:save-as',
    async (event, defaultName?: unknown, data?: unknown, sourcePath?: unknown) => {
      const name =
        (typeof defaultName === 'string' && defaultName) || `presentation-${Date.now()}.pptx`

      // Save-as needs a source path to find the registered session, OR explicit
      // bytes from the renderer.
      let source: string | undefined
      if (typeof sourcePath === 'string' && sourcePath) source = sourcePath
      else source = state.getCurrentPath(sessionIdOf(event))

      const provided = data === undefined || data === null ? null : bytesFrom(data)
      if (provided) {
        const target = workspace.stageBytes(safeFileStem(name), provided)
        const session = source ? state.getSession(source) : undefined
        if (session) {
          // Move the registry entry to the new path so subsequent edits / saves
          // follow the new file rather than the old one.
          state.replaceSession(target, session.opened)
          state.setDirty(target, false)
          state.forgetSessionForPath(source!)
        }
        return { id: `slide-${Date.now()}`, name, ok: true, path: target }
      }

      if (!source) {
        return {
          ok: false,
          canceled: true,
          error: 'slides:save-as: no open deck for this session — call slides:open-path first',
        }
      }
      const sourceSession = state.getSession(source)
      if (!sourceSession) {
        return {
          ok: false,
          canceled: true,
          error: 'slides:save-as: no live model for the source deck — re-open it first',
        }
      }
      const target = workspace.stageBytes(safeFileStem(name), new Uint8Array(0))
      await savePptxToFile(sourceSession.opened, target)
      // Move the registry entry to the new path so subsequent edits / saves
      // follow the new file rather than the old one.
      state.replaceSession(target, sourceSession.opened)
      state.setDirty(target, false)
      state.forgetSessionForPath(source)
      state.setCurrentPath(sessionIdOf(event), target)
      return { id: `slide-${Date.now()}`, name, ok: true, path: target }
    },
  )

  // ── Export ──────────────────────────────────────────────────────────────
  // The renderer rasterizes each visible slide to a base64 PNG in-browser (it
  // owns the canvas) and ships the batch here, so this channel needs no deck
  // model. Desktop parity: `slides:export-images` in apps/slides/src/main.
  registry.registerHandle('slides:export-images', async (_event, op: unknown) => {
    const request = (op || {}) as { dir?: unknown; baseName?: unknown; pngsBase64?: unknown }
    if (typeof request.dir !== 'string' || !Array.isArray(request.pngsBase64)) {
      return { ok: false, error: 'slides:export-images expects { dir, baseName, pngsBase64 }' }
    }
    const rawBase =
      typeof request.baseName === 'string' && request.baseName ? request.baseName : 'slide'
    // baseName reaches us straight from the deck's file name; strip separators,
    // traversal runs and leading dots so a crafted name cannot escape the
    // export dir (the resolve/prefix check below is the hard backstop).
    const safeBase =
      rawBase.replace(/\.\.+/g, '_').replace(/[/\\:*?"<>|]+/g, '_').replace(/^[.\s]+/, '') || 'slide'
    const root = workspace.resolvePath(request.dir)
    if (!root) {
      return { ok: false, error: 'slides:export-images: dir is outside the office-ai workspace' }
    }
    try {
      // Zero-padding width follows the total page count (3 digits for ≥100).
      const pad = request.pngsBase64.length >= 100 ? 3 : 2
      const paths: string[] = []
      for (let i = 0; i < request.pngsBase64.length; i++) {
        const target = resolveInside(root, `${safeBase}-${String(i + 1).padStart(pad, '0')}.png`)
        if (!target) {
          return { ok: false, error: 'slides:export-images: target escapes the export dir' }
        }
        workspace.writeBytes(target, Buffer.from(String(request.pngsBase64[i]), 'base64'))
        paths.push(target)
      }
      return { ok: true, paths }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  registry.registerHandle('slides:export-pdf', () => ({
    ok: true,
    message: '请使用浏览器的打印功能导出 PDF',
  }))

  registry.registerHandle('slides:consume-pending-open', () => null)
  // The renderer calls this on boot to populate a recents list. A library host
  // has no recents store (the consumer owns file history), and an unanswered
  // channel surfaces as a 404 in the console plus an IpcBridgeError rejection
  // — so answer the declared `string[]` with an empty list rather than 404.
  registry.registerHandle('slides:recent', () => [] as string[])
  registry.registerHandle('slides:autosave-pref', () => undefined)

  // Documented renderer-owned stubs: these two channels are inherently
  // desktop/browser-environment features the host can't usefully implement.
  //
  //   - font-download: pulls OFL files from a CDN with sha256 verification and
  //       writes them into a user font store. A library has no font store, and
  //       the browser exposes no FontFace download path — the renderer's
  //       font-manager detects this and uses a CDN directly with its own
  //       sha256 verification.
  //   - font-install-local: pulls files from a native file picker and registers
  //       them as FontFaces. The renderer handles that locally via
  //       `<input type="file">`.
  //
  // Returning `{ ok: true }` keeps the channels registered (the renderer's
  // font-manager checks the response and falls back to the local path; a thrown
  // error would break the menu).
  registry.registerHandle('slides:font-download', () => ({
    ok: true,
    message: 'This host does not download fonts',
  }))
  registry.registerHandle('slides:font-install-local', () => ({ ok: true }))
  registry.registerHandle('slides:insert-model3d', () => ({ ok: true }))
}

/** Join `relative` onto `root` and reject anything that escapes it. */
function resolveInside(root: string, relative: string): string | null {
  const target = resolve(root, relative)
  return target.startsWith(root + sep) ? target : null
}
