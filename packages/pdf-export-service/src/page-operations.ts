/// Pure page operations: PDF bytes in, PDF bytes out, backed only by pdf-lib.
/// Extracted from apps/pdf/src/main/save-pdf.ts so the standalone Web server can
/// serve extract/insert/merge/split/crop/resize without importing Electron.

import { PDFDocument, PDFName, rgb } from 'pdf-lib'

export async function extractPagesBytes(bytes: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const valid = pages.filter((p) => p >= 0 && p < src.getPageCount())
  const copied = await out.copyPages(src, valid)
  for (const p of copied) out.addPage(p)
  return out.save({ useObjectStreams: false })
}

/** Insert all pages of another PDF after afterPageIndex (-1 = front); returns merged bytes and inserted page count */
export async function insertPdfBytes(
  bytes: Uint8Array,
  otherBytes: Uint8Array,
  afterPageIndex: number,
): Promise<{ merged: Uint8Array; count: number }> {
  const dst = await PDFDocument.load(bytes, { updateMetadata: false })
  const src = await PDFDocument.load(otherBytes, { updateMetadata: false })
  const copied = await dst.copyPages(src, src.getPageIndices())
  let at = Math.min(Math.max(afterPageIndex + 1, 0), dst.getPageCount())
  for (const p of copied) dst.insertPage(at++, p)
  return { merged: await dst.save({ useObjectStreams: false }), count: copied.length }
}

/** Insert a blank page after afterPageIndex (-1 = front), sized like the neighboring page */
export async function insertBlankPageBytes(
  bytes: Uint8Array,
  afterPageIndex: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const at = Math.min(Math.max(afterPageIndex + 1, 0), doc.getPageCount())
  const ref = doc.getPage(Math.min(Math.max(afterPageIndex, 0), doc.getPageCount() - 1))
  const page = doc.insertPage(at, [ref.getWidth(), ref.getHeight()])
  // Match the neighbor's /Rotate too, or the blank page displays sideways next to it
  page.setRotation(ref.getRotation())
  return doc.save({ useObjectStreams: false })
}

/** Split into consecutive chunks of chunkSize pages, each becoming its own PDF (in page order) */
export async function splitPdfBytes(bytes: Uint8Array, chunkSize: number): Promise<Uint8Array[]> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const total = src.getPageCount()
  const size = Math.max(1, Math.floor(chunkSize))
  const out: Uint8Array[] = []
  for (let start = 0; start < total; start += size) {
    const part = await PDFDocument.create()
    const count = Math.min(size, total - start)
    const copied = await part.copyPages(
      src,
      Array.from({ length: count }, (_, i) => start + i),
    )
    for (const p of copied) part.addPage(p)
    out.push(await part.save({ useObjectStreams: false }))
  }
  return out
}

export interface MergePagesOptions {
  /** Pages per sheet, 2-16 (WPS-style free count) */
  perSheet: number
  /** Fill order: horizontal = left→right then down, vertical = top→bottom then right */
  direction: 'horizontal' | 'vertical'
  /** Draw hairline separators on the internal cell boundaries */
  separator: boolean
}

/** Grid shape for an N-up sheet: 2-up is a side-by-side pair, otherwise near-square */
export function mergeGrid(perSheet: number): { cols: number; rows: number } {
  const n = Math.min(Math.max(Math.floor(perSheet), 2), 16)
  if (n === 2) return { cols: 2, rows: 1 }
  const cols = Math.ceil(Math.sqrt(n))
  return { cols, rows: Math.ceil(n / cols) }
}

/**
 * N-up imposition: place every perSheet consecutive pages onto one sheet, each
 * scaled to fit its cell and centered. The sheet matches the first page's size;
 * 2-up swaps width/height so two portrait pages sit side by side.
 */
export async function mergePagesBytes(
  bytes: Uint8Array,
  options: MergePagesOptions,
): Promise<Uint8Array> {
  const perSheet = Math.min(Math.max(Math.floor(options.perSheet), 2), 16)
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const total = src.getPageCount()
  const first = src.getPage(0)
  const { cols, rows } = mergeGrid(perSheet)
  const sheetW = perSheet === 2 ? first.getHeight() : first.getWidth()
  const sheetH = perSheet === 2 ? first.getWidth() : first.getHeight()
  // embedPages throws on pages without a content stream (e.g. our own inserted
  // blank pages) — give those an empty stream so they embed as empty cells
  for (const p of src.getPages()) {
    if (!p.node.Contents()) {
      p.node.set(PDFName.of('Contents'), src.context.register(src.context.stream('')))
    }
  }
  const embedded = await out.embedPages(src.getPages())
  const cellW = sheetW / cols
  const cellH = sheetH / rows
  for (let start = 0; start < total; start += perSheet) {
    const sheet = out.addPage([sheetW, sheetH])
    for (let i = 0; i < perSheet && start + i < total; i++) {
      const ep = embedded[start + i]!
      const scale = Math.min(cellW / ep.width, cellH / ep.height)
      const w = ep.width * scale
      const h = ep.height * scale
      const col = options.direction === 'vertical' ? Math.floor(i / rows) : i % cols
      const row = options.direction === 'vertical' ? i % rows : Math.floor(i / cols)
      sheet.drawPage(ep, {
        x: col * cellW + (cellW - w) / 2,
        // PDF y goes up: row 0 must land at the top of the sheet
        y: sheetH - (row + 1) * cellH + (cellH - h) / 2,
        width: w,
        height: h,
      })
    }
    if (options.separator) {
      // Document content (not UI chrome) — a fixed light gray like WPS's segment line
      const line = { thickness: 0.75, color: rgb(0.62, 0.62, 0.62) }
      for (let c = 1; c < cols; c++) {
        sheet.drawLine({
          start: { x: c * cellW, y: 0 },
          end: { x: c * cellW, y: sheetH },
          ...line,
        })
      }
      for (let r = 1; r < rows; r++) {
        sheet.drawLine({
          start: { x: 0, y: r * cellH },
          end: { x: sheetW, y: r * cellH },
          ...line,
        })
      }
    }
  }
  return out.save({ useObjectStreams: false })
}

/**
 * Replace the given pages (original indices) with all pages of another PDF,
 * inserted at the position of the first replaced page.
 */
export async function replacePagesBytes(
  bytes: Uint8Array,
  otherBytes: Uint8Array,
  pages: number[],
): Promise<{ merged: Uint8Array; removed: number; inserted: number }> {
  const dst = await PDFDocument.load(bytes, { updateMetadata: false })
  const src = await PDFDocument.load(otherBytes, { updateMetadata: false })
  const valid = [...new Set(pages.filter((p) => p >= 0 && p < dst.getPageCount()))].sort(
    (a, b) => a - b,
  )
  if (valid.length === 0) throw new Error('replacePages: no valid pages to replace')
  const at = valid[0]!
  for (const p of [...valid].reverse()) dst.removePage(p)
  const copied = await dst.copyPages(src, src.getPageIndices())
  let i = Math.min(at, dst.getPageCount())
  for (const p of copied) dst.insertPage(i++, p)
  return {
    merged: await dst.save({ useObjectStreams: false }),
    removed: valid.length,
    inserted: copied.length,
  }
}

/**
 * Resize every page to the target paper size (points): content and annotations
 * scale uniformly to fit. Centering is done by shifting the MediaBox origin
 * instead of translating the content, so annotations stay aligned with the
 * content they belong to. Pages displayed sideways (/Rotate 90 or 270) get the
 * swapped target so their displayed size matches the chosen paper.
 */
export async function setPageSizeBytes(
  bytes: Uint8Array,
  targetW: number,
  targetH: number,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  for (const page of doc.getPages()) {
    const rot = ((page.getRotation().angle % 360) + 360) % 360
    const tw = rot === 90 || rot === 270 ? targetH : targetW
    const th = rot === 90 || rot === 270 ? targetW : targetH
    const { x, y, width: w, height: h } = page.getMediaBox()
    if (w === tw && h === th) continue
    const k = Math.min(tw / w, th / h)
    page.scaleContent(k, k)
    page.scaleAnnotations(k, k)
    // Both scale about the user-space origin; frame the scaled region centered
    const bx = x * k - (tw - w * k) / 2
    const by = y * k - (th - h * k) / 2
    page.setMediaBox(bx, by, tw, th)
    page.setCropBox(bx, by, tw, th)
  }
  return doc.save({ useObjectStreams: false })
}

/** Map a fractional rect of the displayed page (after /Rotate, y down from the top) to user space */
function displayFracToUserRect(
  rot: number,
  box: { x: number; y: number; width: number; height: number },
  l: number,
  t: number,
  r: number,
  b: number,
): { x: number; y: number; w: number; h: number } {
  const { x: x0, y: y0, width: W, height: H } = box
  if (rot === 90) {
    // display x runs along user +y, display y along user +x
    return { x: x0 + t * W, y: y0 + l * H, w: (b - t) * W, h: (r - l) * H }
  }
  if (rot === 180) {
    return { x: x0 + (1 - r) * W, y: y0 + t * H, w: (r - l) * W, h: (b - t) * H }
  }
  if (rot === 270) {
    return { x: x0 + (1 - b) * W, y: y0 + (1 - r) * H, w: (b - t) * W, h: (r - l) * H }
  }
  return { x: x0 + l * W, y: y0 + (1 - b) * H, w: (r - l) * W, h: (b - t) * H }
}

/**
 * Split every page into a perPage grid of pages (left→right, top→bottom as
 * displayed), the inverse of mergePagesBytes: each cell becomes its own page via
 * a copy with a tightened MediaBox/CropBox, so content is preserved losslessly.
 * The grid is laid out on the displayed page, then mapped through /Rotate.
 */
export async function splitPagesBytes(bytes: Uint8Array, perPage: 2 | 4 | 9): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { updateMetadata: false })
  const out = await PDFDocument.create()
  const { cols, rows } = mergeGrid(perPage)
  const total = src.getPageCount()
  for (let i = 0; i < total; i++) {
    const copies = await out.copyPages(
      src,
      Array.from({ length: perPage }, () => i),
    )
    for (let c = 0; c < perPage; c++) {
      const page = copies[c]!
      const rot = ((page.getRotation().angle % 360) + 360) % 360
      const col = c % cols
      const row = Math.floor(c / cols)
      const rect = displayFracToUserRect(
        rot,
        page.getCropBox(),
        col / cols,
        row / rows,
        (col + 1) / cols,
        (row + 1) / rows,
      )
      page.setMediaBox(rect.x, rect.y, rect.w, rect.h)
      page.setCropBox(rect.x, rect.y, rect.w, rect.h)
      out.addPage(page)
    }
  }
  return out.save({ useObjectStreams: false })
}

/** Crop rectangle as fractions of the displayed page (after /Rotate), y down from the top */
export interface CropFractionsRect {
  l: number
  t: number
  r: number
  b: number
}

/**
 * Shrink the CropBox of the given pages to the fractional rect. The fractions are
 * relative to the page as displayed (rotation applied, y down), so the same rect
 * lands on the same visual region regardless of each page's /Rotate value.
 */
export async function cropPagesBytes(
  bytes: Uint8Array,
  pages: number[],
  frac: CropFractionsRect,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const l = Math.min(Math.max(frac.l, 0), 1)
  const t = Math.min(Math.max(frac.t, 0), 1)
  const r = Math.min(Math.max(frac.r, l), 1)
  const b = Math.min(Math.max(frac.b, t), 1)
  if (r - l <= 0 || b - t <= 0) throw new Error('cropPages: empty crop rect')
  for (const idx of pages) {
    if (idx < 0 || idx >= doc.getPageCount()) continue
    const page = doc.getPage(idx)
    const rot = ((page.getRotation().angle % 360) + 360) % 360
    const rect = displayFracToUserRect(rot, page.getCropBox(), l, t, r, b)
    page.setCropBox(rect.x, rect.y, rect.w, rect.h)
  }
  return doc.save({ useObjectStreams: false })
}

/** Append all pages of the other PDFs (in the given order) to the first; returns combined bytes and appended page count */
export async function mergePdfBytes(
  first: Uint8Array,
  others: Uint8Array[],
): Promise<{ merged: Uint8Array; appended: number }> {
  const dst = await PDFDocument.load(first, { updateMetadata: false })
  let appended = 0
  for (const otherBytes of others) {
    const src = await PDFDocument.load(otherBytes, { updateMetadata: false })
    const copied = await dst.copyPages(src, src.getPageIndices())
    for (const p of copied) dst.addPage(p)
    appended += copied.length
  }
  return { merged: await dst.save({ useObjectStreams: false }), appended }
}
