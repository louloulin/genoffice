/**
 * View payload types the facade owns.
 *
 * These are structural mirrors of the engine payloads `readDocument` surfaces
 * (docx `BlockSummary`, pptx `DeckSummary`, pdf `PdfInfo`, csv `CsvInfo`), kept
 * here rather than re-exported from `@genoffice/*` so the package's published
 * type surface is self-contained: a consumer that only installs
 * `@genoffice/office-ai` needs no GenOffice workspace to typecheck against it.
 * Structural typing keeps them assignable to and from the engine's own types.
 */

/** One top-level block of a docx body, as an agent targets ops at it. */
export interface BlockSummary {
  index: number
  type: string
  level?: number
  /** protected blocks: image, chart, field, formula … */
  kind?: string
  text: string
}

/** One shape on a slide. */
export interface ElementSummary {
  id: string | null
  type: string
  kind?: string
  name?: string
  placeholder?: string
  /** EMU */
  box: { x: number; y: number; cx: number; cy: number }
  text?: string
  rows?: number
  cols?: number
  children?: ElementSummary[]
}

/** One slide. */
export interface SlideSummary {
  index: number
  id: string
  elements: ElementSummary[]
  notes?: string
}

/** A deck's structure: durable ids, EMU geometry, text previews. */
export interface DeckSummary {
  slides: number
  size: { cx: number; cy: number; inches: { width: number; height: number } }
  emu_per_inch: number
  pages: SlideSummary[]
}

/** A PDF's page count and provenance. */
export interface PdfInfo {
  pages: number | null
  encrypted: boolean
  producer?: string
  creator?: string
}

/** A CSV's shape. */
export interface CsvInfo {
  rows: number
  columns: number
  delimiter: string
}
