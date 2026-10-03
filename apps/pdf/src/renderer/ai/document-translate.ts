/**
 * Whole-document translation for the PDF application.
 *
 * ## Why this file is mostly a thin adapter
 *
 * Unlike docs (a ProseMirror tree) or sheets (a cell grid), a PDF has no
 * editable document model in the renderer: the renderer only *draws* pages, and
 * every text change it makes is recorded as a pending edit that the main
 * process replays into the content stream at save time
 * (`LocalTextEdit.input` → `text-edit.ts`, which does pdfium page-object
 * surgery with CJK font subsetting).
 *
 * So this module deliberately does **not** invent a second write path. It
 * reuses the one the text editor already uses:
 *
 *   - `replace`  → one {@link TextEditInput} per block (rebuild in place)
 *   - `bilingual` → one {@link TextInsertInput} per block (translation stacked
 *                    under the original; the original text object is untouched)
 *
 * That is what makes the "in-place" half of the plan's PDF milestone real
 * without a PDF→DOCX fallback for the common case: the engine already covers
 * CJK output, font fallback, wrapping and per-line positioning.
 *
 * ## What is *not* handled here
 *
 * Extraction quality. `groupPageBlocks` is deliberately conservative and may
 * under- or over-cluster on pathological layouts (multi-column tables,
 * rotated stamps). A mis-clustered block is rewritten as one paragraph, which
 * is visible but not silent — and the same clustering already backs the manual
 * block editor, so this is not a new failure mode.
 *
 * Nothing in this file touches pdfium, the DOM, or Node built-ins, so it is
 * unit-testable in plain vitest.
 */
import type {
  TranslateApplyMode,
  TranslateBatchFn,
  TranslateDocumentResult,
  TranslateProgress,
  TranslatedUnit,
  TranslationUnit,
  TranslateDocumentRequest,
} from '@genoffice/translation-core/document'
import { translateDocument } from '@genoffice/translation-core/document'
import type { PageEntry } from '../search'
import { groupPageBlocks, type TextBlock } from '../text-block'
import { joinBlockLines } from '../text-wrap'
import type { TextEditInput, TextInsertInput } from '../../shared/ipc'

/** A paragraph cluster pinned to the page it was extracted from. */
export interface PdfTextBlock {
  pageIndex: number
  block: TextBlock
}

/**
 * Refuse to translate a document with more blocks than this.
 *
 * A pathological scan produces tens of thousands of one-glyph "paragraphs";
 * without a ceiling they all become provider units and the run is billed (and
 * waited on) for a document that is not actually translatable. The ceiling is
 * on the *extraction* side so the user gets an explicit error rather than a
 * progress bar that crawls for an hour.
 */
export const MAX_TRANSLATE_BLOCKS = 4_000

/** Per-block character ceiling; a single huge block is split by the provider's own chunking. */
export const MAX_TRANSLATE_BLOCK_CHARS = 4_000

/**
 * Whether a cluster is worth translating.
 *
 * Skips: blank / whitespace-only clusters, single-character fragments (page
 * numbers, bullet glyphs, list markers that the clusterer split off), and
 * pure-digit runs (totals, dates, phone numbers) — all of which come back
 * from an LLM unchanged at best and mangled at worst.
 */
export function isTranslatableBlockText(text: string): boolean {
  const t = text.trim()
  if (t.length < 2) return false
  if (/^[\d\s.,%+\-*/()]+$/.test(t)) return false
  return true
}

/** The block's logical text: the same join the manual block editor matches against. */
export function pdfBlockText(block: TextBlock): string {
  return joinBlockLines(block.lines.map((l) => l.text))
}

/**
 * Extract every translatable paragraph from a per-page search index.
 *
 * `entries` is indexed by page; `PageEntry` is what `buildSearchIndex` already
 * returns and caches per document, so this costs no extra pdfium work.
 */
export function extractPdfTextBlocks(entries: readonly PageEntry[]): PdfTextBlock[] {
  const out: PdfTextBlock[] = []
  for (let pageIndex = 0; pageIndex < entries.length; pageIndex++) {
    const entry = entries[pageIndex]
    if (!entry) continue
    for (const block of groupPageBlocks(entry)) {
      const text = pdfBlockText(block)
      if (!isTranslatableBlockText(text)) continue
      out.push({ pageIndex, block })
      if (out.length > MAX_TRANSLATE_BLOCKS) return out
    }
  }
  return out
}

/** Stable unit id: `p<page>-b<blockWithinPage>`, so a unit round-trips back to its geometry. */
function pdfUnitId(pageIndex: number, blockIndex: number): string {
  return `p${pageIndex}-b${blockIndex}`
}

export function parsePdfUnitId(unitId: string): { pageIndex: number; blockIndex: number } | null {
  const m = /^p(\d+)-b(\d+)$/.exec(unitId)
  if (!m) return null
  return { pageIndex: Number(m[1]), blockIndex: Number(m[2]) }
}

/** Turn extracted blocks into provider units, carrying each block's geometry in metadata. */
export function pdfBlocksToUnits(blocks: readonly PdfTextBlock[]): TranslationUnit[] {
  const perPageCount = new Map<number, number>()
  return blocks.map(({ pageIndex, block }) => {
    const blockIndex = perPageCount.get(pageIndex) ?? 0
    perPageCount.set(pageIndex, blockIndex + 1)
    return {
      unitId: pdfUnitId(pageIndex, blockIndex),
      kind: 'paragraph' as const,
      sourceText: pdfBlockText(block),
      order: 0,
      metadata: { pageIndex, blockIndex },
    }
  })
}

/** Look a settled unit's block back up by the id minted at extraction time. */
function blockOf(
  unit: TranslatedUnit,
  byUnitId: ReadonlyMap<string, PdfTextBlock>,
): PdfTextBlock | null {
  return byUnitId.get(unit.unitId) ?? null
}

/**
 * Build the in-place rebuild edit for one block.
 *
 * Mirrors `blockMoveInput` in `text-edit-preview.tsx` **minus** the move: the
 * matched anchor object can be an indented or mid-paragraph run, so the
 * rebuild is pinned to the block's left edge / first baseline rather than left
 * to inherit the anchor's position. `translate` is deliberately absent — that
 * field means "move the run as-is", which is not what a translation is.
 */
export function buildPdfReplaceInput(
  pageIndex: number,
  block: TextBlock,
  translatedText: string,
): TextEditInput {
  const oldText = pdfBlockText(block)
  const input: TextEditInput = {
    pageIndex,
    rect: [...block.rect] as [number, number, number, number],
    oldText,
    newText: translatedText,
    fontSize: block.fontSize,
    origin: [block.rect[0], block.lines[0]!.y],
    lineLeading: block.lineHeight,
    blockSource: translatedText,
  }
  if (block.align !== 'left') input.align = block.align
  return input
}

/**
 * Where a bilingual block's translation goes.
 *
 * PDF user space is y-up, so "below the block" is *smaller* y, and one line of
 * leading is left as a gap.
 *
 * `pageBottomY` is the **MediaBox bottom in user space** (pdf.js `page.view[1]`),
 * not a viewport height: `/Rotate` changes the display transform, not the
 * content coordinate system, so y < MediaBox bottom is off-page no matter how
 * the page is presented. A translation rendered there is invisible, which is
 * the one outcome a user cannot tell apart from "nothing was translated" — so
 * when there is no room below, the text goes above instead. Passing `undefined`
 * (page geometry not available) keeps the below-the-block placement.
 */
export function pdfBilingualOrigin(
  block: TextBlock,
  pageBottomY: number | undefined,
): [number, number] {
  const gap = block.lineHeight
  const below = block.rect[1] - gap
  if (pageBottomY === undefined || below >= pageBottomY) return [block.rect[0], below]
  const above = block.rect[3] + gap
  return [block.rect[0], above]
}

/** Build the stacked-insert edit for one block (bilingual mode). */
export function buildPdfBilingualInput(
  pageIndex: number,
  block: TextBlock,
  translatedText: string,
  pageBottomY?: number | undefined,
): TextInsertInput {
  const input: TextInsertInput = {
    pageIndex,
    origin: pdfBilingualOrigin(block, pageBottomY),
    text: translatedText,
    fontSize: block.fontSize,
    // Absent = the engine's own default ink. The original run's colour is not
    // recoverable from a paragraph cluster (it is per-run, not per-block), and
    // guessing it would tint translated text with the colour of whichever run
    // happened to be measured last.
    color: [0, 0, 0],
    lineLeading: block.lineHeight,
  }
  if (block.align !== 'left') input.align = block.align
  return input
}

export interface PdfTranslateDeps {
  /** Per-page search index, as returned (and cached) by `buildSearchIndex`. */
  searchIndex: readonly PageEntry[]
  translateBatch: TranslateBatchFn
  onProgress?: ((progress: TranslateProgress) => void | Promise<void>) | undefined
  /**
   * MediaBox bottom edge per page, in PDF user space, indexed like
   * `searchIndex`. Enables the bilingual "would the translation land off-page"
   * guard; omit it and translations always stack below their block.
   */
  pageBottoms?: readonly number[] | undefined
  /**
   * Receives the pending-edit plan the run produced.
   *
   * The pipeline's `apply` contract returns `void`, but the PDF renderer needs
   * the concrete {@link PdfTranslationPlan} to push into its `textEdits` /
   * `textEdits`-alongside state — so the default apply hands it here instead
   * of discarding it. Without this the run would report `completed` while
   * nothing was ever written.
   */
  onPlan?: ((plan: PdfTranslationPlan) => void) | undefined
  /**
   * Receives the blocks the run extracted from.
   *
   * A review-then-apply caller needs them: the apply step re-derives each
   * block's geometry from its id, and re-extracting at Apply time could
   * re-cluster a document the user edited while reviewing — writing the
   * translation onto a paragraph the run never saw.
   */
  onBlocks?: ((blocks: readonly PdfTextBlock[]) => void) | undefined
  /**
   * Override the write-back. The default produces the pending-edit lists; a
   * review-then-apply UI passes a no-op and calls {@link applyPdfTranslations}
   * itself after the user approves.
   */
  apply?:
    | ((context: { units: TranslatedUnit[]; mode: TranslateApplyMode }) => void | Promise<void>)
    | undefined
}

export interface PdfTranslateOptions {
  targetLang: string
  sourceLang?: string | undefined
  preserveFormat?: boolean | undefined
  applyMode?: TranslateApplyMode | undefined
  memoryEnabled?: boolean | undefined
  qualityCheck?: boolean | undefined
  glossaryCategory?: string | undefined
  scene?: string | undefined
  signal?: AbortSignal | undefined
}

/** What a whole-document run produced, ready for the renderer's pending-edit state. */
export interface PdfTranslationPlan {
  /** In-place rebuilds (replace mode). */
  edits: TextEditInput[]
  /** Stacked insertions (bilingual mode). */
  inserts: TextInsertInput[]
}

/**
 * Write settled translations into the pending-edit lists.
 *
 * Exported so a review-then-apply dialog can do the same write the pipeline
 * would have done inline. Two implementations of "where does a translation go"
 * is how bilingual text ends up on the wrong side of a page after one of them
 * drifts, so both call this one.
 */
export function applyPdfTranslations(
  blocks: readonly PdfTextBlock[],
  units: readonly TranslatedUnit[],
  mode: TranslateApplyMode,
  pageBottoms?: readonly number[] | undefined,
): PdfTranslationPlan {
  const byUnitId = new Map<string, PdfTextBlock>()
  const perPageCount = new Map<number, number>()
  for (const { pageIndex, block } of blocks) {
    const blockIndex = perPageCount.get(pageIndex) ?? 0
    perPageCount.set(pageIndex, blockIndex + 1)
    byUnitId.set(pdfUnitId(pageIndex, blockIndex), { pageIndex, block })
  }

  const plan: PdfTranslationPlan = { edits: [], inserts: [] }
  for (const unit of units) {
    if (typeof unit.translatedText !== 'string' || !unit.translatedText.trim()) continue
    const hit = blockOf(unit, byUnitId)
    if (!hit) continue
    if (mode === 'bilingual') {
      plan.inserts.push(
        buildPdfBilingualInput(
          hit.pageIndex,
          hit.block,
          unit.translatedText,
          pageBottoms?.[hit.pageIndex],
        ),
      )
    } else {
      plan.edits.push(buildPdfReplaceInput(hit.pageIndex, hit.block, unit.translatedText))
    }
  }
  return plan
}

/**
 * Translate every paragraph of a PDF.
 *
 * Returns the shared pipeline's result verbatim so the caller reports
 * `completed` / `failed` / `cancelled` without re-deriving them. A cancelled
 * run produces no plan at all — a half-translated PDF is indistinguishable
 * from a finished one.
 */
export async function translatePdfDocument(
  deps: PdfTranslateDeps,
  options: PdfTranslateOptions,
): Promise<TranslateDocumentResult> {
  const blocks = extractPdfTextBlocks(deps.searchIndex)
  deps.onBlocks?.(blocks)
  const units = pdfBlocksToUnits(blocks)
  const mode: TranslateApplyMode = options.applyMode ?? 'replace'

  const request: TranslateDocumentRequest = {
    units,
    sourceLang: options.sourceLang,
    targetLang: options.targetLang,
    preserveFormat: options.preserveFormat,
    scene: options.scene ?? 'pdf-document',
    memoryEnabled: options.memoryEnabled,
    qualityCheck: options.qualityCheck,
    glossaryCategory: options.glossaryCategory,
    applyMode: mode,
  }

  return translateDocument(request, {
    translateBatch: deps.translateBatch,
    // `exactOptionalPropertyTypes` is on in this app: an absent callback has to
    // be *absent*, not `undefined`.
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
    apply:
      deps.apply ??
      (({ units: settled }) => {
        const plan = applyPdfTranslations(blocks, settled, mode, deps.pageBottoms)
        deps.onPlan?.(plan)
      }),
  })
}
