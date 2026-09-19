/**
 * Core slides lifecycle channels — new-blank, recent, open, open-path,
 * save, save-as, export-pdf, consume-pending-open, font-download/install,
 * insert-model3d. Persistence uses `slides-recent.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { FILES_DIR, loadRecentSlides, registerHandle, requireManagedPath, saveRecentSlides } from '../common/index'
import { openPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide, HeuristicMetrics } from '@genoffice/pptx-render'
import { parseTheme } from '@genoffice/pptx-engine'
import { displayMime } from '../../../slides/src/main/media-mime'
import { neutralizeJpegOrientation } from '../../../slides/src/main/jpeg-orientation'
import { tiffToPng } from '../../../slides/src/main/tiff-decode'
import type { OpenedPptx, Slide } from '@genoffice/pptx-engine'
import { CorruptError, NotFoundError } from '../ai/errors'

/** Mirror of the desktop `deckDefaultFont` in apps/slides/src/main/slides-main.ts:
 *  pull the deck's minor (body) Latin font from theme1.xml so the ribbon font box
 *  has something meaningful even before the user picks a selection. */
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

/** web-server-only media resolver (no theme-tint rewrite, no electron deps).
 *  Decodes TIFF → PNG inline, neutralises EXIF orientation for JPEG, base64
 *  everything else as `data:` URLs the renderer can `<img src=>` directly. */
function makeWebMediaResolver(opened: OpenedPptx, _slidePath?: string) {
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

/** Web-server renderer: deterministic heuristic metrics (no font parsing).
 *  Matches the desktop fallback when `createSystemFontMetrics` hasn't initialised. */
const webMetrics = new HeuristicMetrics()

function buildWebRenderSlides(opened: OpenedPptx, fitWidthPx: number) {
  return opened.deck.slides.map((s: Slide, i: number) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeWebMediaResolver(opened, s.path),
      metrics: webMetrics,
      slideNo: i + 1,
    }),
  )
}

/** Default slide canvas width used when the renderer doesn't pass `fitWidthPx`.
 *  Matches the desktop default (`FIT_WIDTH = 1280` in apps/slides). */
const DEFAULT_FIT_WIDTH = 1280

export function registerSlidesCoreHandlers(): void {
  registerHandle('slides:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = `演示文稿-${new Date().toLocaleDateString()}.pptx`
    const path = join(FILES_DIR, `${id}.pptx`)

    if (opts?.pptx) {
      writeFileSync(path, Buffer.from(opts.pptx))
    }

    const recent = loadRecentSlides()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    return {
      path: '',
      slides: [
        {
          widthPx: 1280,
          heightPx: 720,
          scale: 1,
          background: { kind: 'solid', color: '#FFFFFF' },
          nodes: [],
        },
      ],
      size: { cx: 12192000, cy: 6858000 },
      defaultFont: 'Aptos',
    }
  })

  registerHandle('slides:recent', () => loadRecentSlides())

  registerHandle('slides:open', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = opts?.path ? basename(opts.path) : `演示文稿-${Date.now()}.pptx`

    return { id, path: opts?.path || '', name }
  })

  registerHandle('slides:open-path', async (_event: unknown, filePath: unknown) => {
    const path = requireManagedPath('slides:open-path', filePath)
    if (!existsSync(path)) {
      throw new NotFoundError('slides:open-path', `File not found: ${path}`)
    }

    const bytes = readFileSync(path)
    const name = basename(path)
    const id = `slide-${Date.now()}`

    // Match the desktop `slides:open-path` shape: parse the pptx via `@genoffice/pptx-engine`
    // and return the same `{path, slides, size, defaultFont}` the renderer expects. Without
    // this the web renderer keeps `slides` as `undefined` and the boot screen never goes
    // away. Uses the web-only helpers above so we avoid the harfbuzz wasm + electron
    // deps that the desktop `render-helpers.ts` transitively pulls in.
    // A file that is not a pptx is a client-side problem (422), not a server
    // fault: the parse used to throw out of the handler as an unhandled 500.
    let opened: Awaited<ReturnType<typeof openPptx>>
    try {
      opened = await openPptx(new Uint8Array(bytes))
    } catch (err) {
      throw new CorruptError(
        'slides:open-path',
        `Failed to parse deck: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    // Recorded only now that the deck actually parses: a corrupt file used to
    // reach the recents list and then fail, so "recently opened" listed decks
    // that never opened.
    const recent = loadRecentSlides()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    const slides = buildWebRenderSlides(opened, DEFAULT_FIT_WIDTH)

    return {
      path,
      slides,
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  })

  // ── Save ───────────────────────────────────────────────────────────────
  // The desktop main process is the authority for a deck: the renderer streams
  // `slides:apply-txn` ops and main mutates the parsed `OpenedPptx`, so
  // `savePptxToFile` can serialize the user's edits from that model. The web
  // build has no such model — the element/edit channels are acknowledged as
  // no-ops and the renderer never hands over pptx bytes — so a save here cannot
  // serialize anything.
  //
  // The handlers below still accept bytes for a future renderer-side
  // serialization, but answer honestly when none arrive. Previously they
  // reported `{ ok: true }` while writing nothing (showing a "已保存" toast and
  // silently discarding the deck), and `slides:save-as` replied without an `ok`
  // field at all, so the renderer classified a save-as as neither success nor
  // failure and did nothing whatsoever.
  const WEB_SAVE_UNSUPPORTED =
    'WEB_UNSUPPORTED: web 版暂不支持保存编辑后的 PPTX（渲染层编辑尚未同步到服务器模型）'

  registerHandle(
    'slides:save',
    async (_event: unknown, _id?: unknown, path?: unknown, data?: unknown) => {
      if (typeof path === 'string' && data) {
        // Re-create the parent before each write so an rm -rf of DATA_DIR
        // does not ENOENT the first save. The renderer is expected to keep
        // passing a FILES_DIR-resident path (set by slides:save-as) so the
        // existing bytes are overwritten in place.
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.from(data as ArrayBuffer))
        return { ok: true, path }
      }
      return { ok: false, canceled: true, error: WEB_SAVE_UNSUPPORTED }
    },
  )

  registerHandle(
    'slides:save-as',
    async (_event: unknown, defaultName?: unknown, data?: unknown) => {
      const id = `slide-${Date.now()}`
      const name = (typeof defaultName === 'string' && defaultName) || `演示文稿.pptx`
      const path = join(FILES_DIR, `${id}.pptx`)

      if (data) {
        mkdirSync(FILES_DIR, { recursive: true })
        writeFileSync(path, Buffer.from(data as ArrayBuffer))
        return { id, name, ok: true, path }
      }
      return { id, name, ok: false, canceled: true, error: WEB_SAVE_UNSUPPORTED }
    },
  )

  // ── Export images ──────────────────────────────────────────────────────
  // The renderer rasterizes each visible slide to a base64 PNG in-browser (it
  // owns the canvas) and ships the batch here, so this channel needs no deck
  // model and is fully supported in the web build. Desktop parity:
  // `slides:export-images` in apps/slides/src/main/slides-main.ts. This channel
  // used to be unregistered, which made the renderer's export click 404.
  registerHandle('slides:export-images', async (_event: unknown, op: unknown) => {
    const request = (op || {}) as { dir?: unknown; baseName?: unknown; pngsBase64?: unknown }
    if (typeof request.dir !== 'string' || !Array.isArray(request.pngsBase64)) {
      return { ok: false, error: 'slides:export-images expects { dir, baseName, pngsBase64 }' }
    }
    const rawBase = typeof request.baseName === 'string' && request.baseName ? request.baseName : 'slide'
    // baseName reaches us straight from the deck's file name; strip separators,
    // traversal runs and leading dots so a crafted name cannot escape the
    // export dir (the resolve/prefix check below is the hard backstop).
    const safeBase =
      rawBase
        .replace(/\.\.+/g, '_')
        .replace(/[/\\:*?"<>|]+/g, '_')
        .replace(/^[.\s]+/, '') || 'slide'
    try {
      const root = resolve(request.dir)
      mkdirSync(root, { recursive: true })
      // Zero-padding width follows the total page count (3 digits for ≥100 pages).
      const pad = request.pngsBase64.length >= 100 ? 3 : 2
      const paths: string[] = []
      for (let i = 0; i < request.pngsBase64.length; i++) {
        const target = resolve(root, `${safeBase}-${String(i + 1).padStart(pad, '0')}.png`)
        if (!target.startsWith(root + sep)) {
          return { ok: false, error: 'slides:export-images: target escapes the export dir' }
        }
        writeFileSync(target, Buffer.from(String(request.pngsBase64[i]), 'base64'))
        paths.push(target)
      }
      return { ok: true, paths }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  registerHandle('slides:export-pdf', () => ({
    ok: true,
    message: '请使用浏览器的打印功能导出 PDF',
  }))

  registerHandle('slides:consume-pending-open', () => null)
  registerHandle('slides:autosave-pref', () => undefined)

  registerHandle('slides:font-download', () => ({
    ok: true,
    message: 'Web 版本不支持字体下载',
  }))

  registerHandle('slides:font-install-local', () => ({ ok: true }))

  registerHandle('slides:insert-model3d', () => ({ ok: true }))
}
