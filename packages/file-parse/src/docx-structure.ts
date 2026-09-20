/**
 * Structural extraction for DOCX — tables and images.
 *
 * The text path (`docxToText`) flattens everything into a single
 * string. The structural path keeps the table / image geometry so the
 * web-server's `anydoc:extract-tables` / `anydoc:extract-images`
 * handlers (and any other caller that wants shape) can hand it back to
 * the renderer verbatim.
 *
 * Both helpers funnel through `parseDocx` from `@genoffice/docx-engine`
 * so the same XML edge cases (encrypted parts, altChunk, passthrough
 * blocks, layout-only tables in headers/footers) are handled in one
 * place. The returned shape is intentionally narrow — only the fields
 * that survive a JSON serialisation to the renderer are exposed.
 */
import { parseDocx } from '@genoffice/docx-engine'

export interface ExtractedDocxTable {
  /**
   * Row-major cell text. Each cell's paragraphs are joined with a single
   * newline so multi-paragraph cells do not collapse silently.
   */
  rows: string[][]
  /** Stable id from the underlying block — useful for editor round-trips. */
  blockId: string
  /** Display-only label such as "Table 3×4" when the parser produced one. */
  label?: string
}

export interface ExtractedDocxImage {
  /** Data URL of the image's bytes (PNG / JPEG / GIF / etc. — whatever the part stored). */
  dataUrl: string
  /** CSS-pixel width from `wp:extent`, when the document declared one. */
  widthPx?: number
  /** CSS-pixel height from `wp:extent`, when the document declared one. */
  heightPx?: number
  /** Stable id from the underlying block. */
  blockId: string
  /** Display-only label from the parser (typically the literal word "Image"). */
  label?: string
}

/**
 * Pull every top-level body table out of a docx file. Tables inside
 * headers / footers / textboxes are intentionally skipped — those are
 * layout-only cells the editor round-trip cares about, not content the
 * `anydoc` consumer wants.
 *
 * Returns an empty array when the file has no tables, parses to no
 * blocks, or fails to parse. Errors are surfaced as a thrown `Error`
 * so the caller can decide between throwing a 400 or returning
 * `unsupported`.
 */
export async function extractDocxTables(bytes: Uint8Array): Promise<ExtractedDocxTable[]> {
  const doc = await parseDocx(new Uint8Array(bytes))
  const tables: ExtractedDocxTable[] = []
  for (const block of doc.blocks) {
    if (block.type !== 'table') continue
    const rows = block.table?.rows ?? []
    tables.push({
      rows: rows.map((row) => row.map((cell) => cell.paras.join('\n').trim())),
      blockId: block.id,
      ...(block.label ? { label: block.label } : {}),
    })
  }
  return tables
}

/**
 * Pull every top-level body image out of a docx file. Inline
 * `<w:drawing>` images in the body are returned; image parts only
 * referenced from headers / footers are skipped (the desktop preview
 * pane is the right place to render those, not a structural
 * `extract-images` consumer).
 *
 * Returns an empty array when the file has no images, parses to no
 * blocks, or fails to parse. The data URLs are returned verbatim from
 * `block.imageDataUrl`; the parser already base64-encodes the part.
 */
export async function extractDocxImages(bytes: Uint8Array): Promise<ExtractedDocxImage[]> {
  const doc = await parseDocx(new Uint8Array(bytes))
  const images: ExtractedDocxImage[] = []
  for (const block of doc.blocks) {
    if (block.type !== 'image') continue
    if (!block.imageDataUrl) continue
    const image: ExtractedDocxImage = {
      dataUrl: block.imageDataUrl,
      blockId: block.id,
      ...(typeof block.imageWidthPx === 'number' ? { widthPx: block.imageWidthPx } : {}),
      ...(typeof block.imageHeightPx === 'number' ? { heightPx: block.imageHeightPx } : {}),
      ...(block.label ? { label: block.label } : {}),
    }
    images.push(image)
  }
  return images
}
