/**
 * Core slides lifecycle channels — new-blank, recent, open, open-path,
 * save, save-as, export-pdf, consume-pending-open, font-download/install,
 * insert-model3d. Persistence uses `slides-recent.json`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { FILES_DIR, loadRecentSlides, registerHandle, saveRecentSlides } from '../common/index'
import { openPptx } from '@genoffice/pptx-engine'
import { buildRenderSlide, HeuristicMetrics } from '@genoffice/pptx-render'
import { parseTheme } from '@genoffice/pptx-engine'
import { displayMime } from '../../../slides/src/main/media-mime'
import { neutralizeJpegOrientation } from '../../../slides/src/main/jpeg-orientation'
import { tiffToPng } from '../../../slides/src/main/tiff-decode'
import type { OpenedPptx, Slide } from '@genoffice/pptx-engine'
import { NotFoundError } from '../ai/errors'

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
    if (!existsSync(filePath as string)) {
      throw new NotFoundError('slides:open-path', `File not found: ${String(filePath)}`)
    }

    const bytes = readFileSync(filePath as string)
    const name = basename(filePath as string)
    const id = `slide-${Date.now()}`

    const recent = loadRecentSlides()
    recent.unshift({ id, path: filePath as string, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    // Match the desktop `slides:open-path` shape: parse the pptx via `@genoffice/pptx-engine`
    // and return the same `{path, slides, size, defaultFont}` the renderer expects. Without
    // this the web renderer keeps `slides` as `undefined` and the boot screen never goes
    // away. Uses the web-only helpers above so we avoid the harfbuzz wasm + electron
    // deps that the desktop `render-helpers.ts` transitively pulls in.
    const opened = await openPptx(new Uint8Array(bytes))
    const slides = buildWebRenderSlides(opened, DEFAULT_FIT_WIDTH)

    return {
      path: filePath,
      slides,
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  })

  registerHandle(
    'slides:save',
    async (_event: unknown, _id?: unknown, path?: unknown, data?: unknown) => {
      if (data && typeof path === 'string') {
        // Re-create the parent before each write so an rm -rf of DATA_DIR
        // does not ENOENT the first save. The renderer is expected to keep
        // passing a FILES_DIR-resident path (set by slides:save-as) so the
        // existing bytes are overwritten in place.
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, Buffer.from(data as ArrayBuffer))
      }
      return { ok: true, path: typeof path === 'string' ? path : undefined }
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
      }

      return { id, path, name }
    },
  )

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
