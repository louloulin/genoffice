/// Pure main-process render helpers for slides. Lives outside `session-state.ts`
/// so the web server (`apps/web-server/src/slides/core.ts`) can reuse
/// `openPptx` → `buildAllRenderSlides` without dragging in `electron`.
import {
  materializeSlide,
  type OpenedPptx,
} from '@genoffice/pptx-engine'
import {
  buildRenderSlide,
  type FontMetricsProvider,
  type RenderSlide,
} from '@genoffice/pptx-render'
import { createSystemFontMetrics, resetFontRegistry } from './fonts'
import { tiffToPng } from './tiff-decode'
import { neutralizeJpegOrientation } from './jpeg-orientation'
import { displayMime } from './media-mime'

let fontMetrics: FontMetricsProvider | null = null
export function getFontMetrics(): FontMetricsProvider {
  if (!fontMetrics) fontMetrics = createSystemFontMetrics()
  return fontMetrics
}

export function resetFontMetrics(): void {
  resetFontRegistry()
  fontMetrics = null
}

// `_slidePath` is accepted but unused here: this headless copy resolves media
// without theme retinting. The desktop copy in session-state.ts uses the slide
// path to retint themed SVGs; keeping the same signature lets both call sites
// stay interchangeable.
export function makeMediaResolver(opened: OpenedPptx, _slidePath?: string) {
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
      } else if (mime === 'image/svg+xml') {
        const text = Buffer.from(bytes).toString('utf8')
        // Theme-tinted SVG rewrite is desktop-only (needs retintThemedSvg from session-state).
        // The web renderer can still display the raw SVG inline; theme tints are a visual nicety.
        url = `data:${mime};base64,${Buffer.from(text, 'utf8').toString('base64')}`
      } else {
        const served = mime === 'image/jpeg' ? neutralizeJpegOrientation(bytes) : bytes
        url = `data:${mime};base64,${Buffer.from(served).toString('base64')}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}

export function buildAllRenderSlides(opened: OpenedPptx, fitWidthPx: number): RenderSlide[] {
  return opened.deck.slides.map((s, i) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeMediaResolver(opened, s.path),
      metrics: getFontMetrics(),
      slideNo: i + 1,
    }),
  )
}

/** Rebuild a single slide after a chart edit (model stale, needs reparse). */
export function rebuildSlideWithReparse(opened: OpenedPptx, slideIndex: number, fitWidthPx: number): RenderSlide | null {
  const fresh = materializeSlide(opened, slideIndex)
  if (!fresh) return null
  return buildRenderSlide(fresh, opened.deck.size, {
    fitWidthPx,
    media: makeMediaResolver(opened, fresh.path),
    metrics: getFontMetrics(),
    slideNo: slideIndex + 1,
  })
}
