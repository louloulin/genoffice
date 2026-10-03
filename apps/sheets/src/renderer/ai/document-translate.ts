/**
 * Whole-workbook (active sheet) translation for the sheets app.
 *
 * Before this module the sheets app only had a one-shot **selection**
 * translation; the shared pipeline in `@genoffice/translation-core/document`
 * was docs-only. This is the sheets adapter: it supplies the two
 * host-specific halves of that pipeline — *extract* the translatable cells and
 * *apply* the settled translations back — and inherits batching, progress,
 * quality, cancel and bilingual/replace planning from the shared core.
 *
 * The rules that are **not** negotiable, because breaking them silently
 * corrupts a user's spreadsheet:
 *   - numbers, booleans, dates, blanks and **formulas** are never translated;
 *   - cell styles, formats, column widths and merges are never touched;
 *   - a bilingual run never overwrites existing data.
 */

import {
  translateDocument,
  type TranslateApplyMode,
  type TranslateBatchFn,
  type TranslateBatchRequest,
  type TranslatedUnit,
  type TranslateBatchResponse,
  type TranslateBatchUnitResult,
  type TranslateDocumentResult,
  type TranslateProgress,
  type TranslationUnit,
} from '@genoffice/translation-core/document'

/** The slice of the Univer cell model this module needs. */
export interface SheetCellLike {
  v?: unknown
  f?: string | null
}

export interface SheetRangeLike {
  setValue(value: { v?: unknown; f?: string }): void
}

export interface SheetTranslateWorksheet {
  getLastRow(): number
  getLastColumn(): number
  getSheetId(): string
  getSheetName(): string
  getRange(row: number, column: number, numRows: number, numColumns: number): SheetRangeLike
  getSheet(): {
    getCellMatrix(): {
      forValue(callback: (row: number, column: number, cell: SheetCellLike | null) => unknown): void
    }
  }
}

/**
 * A translatable cell. `row` / `column` are Univer's zero-based coordinates —
 * the same numbers `getRange` takes — so extraction and apply cannot drift
 * apart over an off-by-one in a sheet whose first row is row 0.
 */
export interface SheetTextCell {
  row: number
  column: number
  text: string
}

/**
 * Ceiling on the cells one run will translate.
 *
 * A 200k-cell sheet would otherwise fan out into thousands of provider calls
 * with no way to stop, and the user gets a dialog that looks stuck. Hitting it
 * is reported as `failed` with a message naming the number — never a silent
 * truncation, because a half-translated sheet that reports success is the one
 * outcome a user cannot detect.
 */
export const MAX_TRANSLATE_CELLS = 20_000

/** Longest single cell worth translating; anything longer is usually a dump. */
export const MAX_TRANSLATE_CELL_CHARS = 4_000

/**
 * Is this cell translatable *text*?
 *
 * Deliberately narrow: a formula cell carries `f`, and translating its display
 * text would replace a live formula with a constant. Numbers, booleans and
 * dates come through as non-string `v` and are skipped by the same test.
 */
export function isTranslatableCellText(cell: SheetCellLike | null | undefined): cell is { v: string } {
  if (!cell || typeof cell.f === 'string' && cell.f.trim() !== '') return false
  const value = cell.v
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '') return false
  return trimmed.length <= MAX_TRANSLATE_CELL_CHARS
}

/**
 * Collect every translatable cell of a sheet.
 *
 * Throws (rather than returning a truncated list) when the sheet exceeds
 * {@link MAX_TRANSLATE_CELLS}: the caller turns that into a visible `failed`
 * status, which is the only honest outcome for "we cannot translate all of
 * this yet".
 */
export function extractSheetTextCells(sheet: SheetTranslateWorksheet): SheetTextCell[] {
  const cells: SheetTextCell[] = []
  sheet.getSheet().getCellMatrix().forValue((row, column, cell) => {
    if (!isTranslatableCellText(cell)) return undefined
    if (cells.length >= MAX_TRANSLATE_CELLS) {
      throw new Error(
        `工作表文本单元格超过 ${MAX_TRANSLATE_CELLS} 个，请先选中要翻译的区域再试`,
      )
    }
    cells.push({ row, column, text: cell.v })
    return undefined
  })
  return cells
}

/** Map sheet cells onto the pipeline's extraction order. */
export function sheetCellsToUnits(
  cells: readonly SheetTextCell[],
  sheetId: string,
): TranslationUnit[] {
  return cells.map((cell, order) => ({
    unitId: `${sheetId}!${cell.row}:${cell.column}`,
    order,
    // 共享 vocabulary 里没有 'text'：表格单元格归 `table-cell`，质量检查按
    // 表格文本的规则处理（短文本、术语密度），不会按段落的长文本规则误判。
    kind: 'table-cell' as const,
    sourceText: cell.text,
    // The cell coordinates travel as metadata so `apply` never has to
    // re-derive them: a mismatch here would write translations into the wrong
    // cells, which is unrecoverable from the user's point of view.
    metadata: { row: cell.row, column: cell.column, sheetId },
  }))
}

/**
 * Recover the cell coordinates from a unit id produced by {@link sheetCellsToUnits}.
 *
 * The review-then-apply flow needs this: the dialog runs the pipeline with a
 * no-op `apply` and hands the write back as a flat list of `{ unitId, ... }`,
 * so the coordinates have to survive the round trip through the UI. Parsing the
 * id we minted is the honest way to do that — re-deriving the coordinates from
 * the *current* sheet state instead would silently mis-target every cell if the
 * user inserted or deleted a row while the dialog was open.
 *
 * Returns `null` for an id that is not one of ours.
 */
export function parseSheetUnitId(unitId: string): { sheetId: string; row: number; column: number } | null {
  const separator = unitId.lastIndexOf('!')
  if (separator <= 0) return null
  const sheetId = unitId.slice(0, separator)
  const coordinates = unitId.slice(separator + 1).split(':')
  if (coordinates.length !== 2) return null
  const row = Number(coordinates[0])
  const column = Number(coordinates[1])
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null
  return { sheetId, row, column }
}

/**
 * Where a bilingual run writes each source column.
 *
 * One output column per source column, laid out immediately to the right of
 * the used block: `outputCol(c) = usedColumns + c`. The naive "next column"
 * rule (`c + 1`) silently overwrites whatever the user already had to the
 * right of a partly-filled column, and "insert a column" mutates the sheet's
 * structure — so neither is acceptable. Offsetting by the full used width
 * keeps every row aligned and cannot collide with existing data.
 *
 * Exported separately (and pure) so the rule is unit-testable without a live
 * Univer instance.
 */
export function planSheetBilingualColumn(sourceColumn: number, usedColumns: number): number {
  return usedColumns + sourceColumn
}

/**
 * The transport the sheets UI injects.
 *
 * Same shape as the shared pipeline's own {@link TranslateBatchFn} but with the
 * per-unit listener hoisted into the positional signature, because the UI
 * builds it positionally and having one exported name for it keeps the dialog
 * props and the App wiring from drifting into two slightly different shapes.
 */
export type SheetTranslateBatchFn = (
  request: TranslateBatchRequest,
  signal: AbortSignal | undefined,
  onUnit: (unit: TranslateBatchUnitResult) => void,
) => Promise<TranslateBatchResponse>

export interface SheetTranslateOptions {
  targetLang: string
  sourceLang?: string | undefined
  /** Keep inline formatting, numbers and placeholders intact. Defaults on. */
  preserveFormat?: boolean | undefined
  applyMode?: TranslateApplyMode | undefined
  memoryEnabled?: boolean | undefined
  qualityCheck?: boolean | undefined
  glossaryCategory?: string | undefined
  scene?: string | undefined
  signal?: AbortSignal | undefined
}

export interface SheetTranslateDeps {
  sheet: SheetTranslateWorksheet
  translateBatch: TranslateBatchFn
  onProgress?: ((progress: TranslateProgress) => void | Promise<void>) | undefined
  /**
   * Override the write-back.
   *
   * The default writes the settled translations straight into the sheet. A
   * review-then-apply UI passes a no-op here and performs the same write later
   * through {@link applySheetTranslations}, so the user can review each cell
   * before anything changes — and both paths share one "where does a
   * translation go" implementation.
   */
  apply?: ((context: { units: TranslatedUnit[]; mode: TranslateApplyMode }) => void | Promise<void>) | undefined
}

interface CellCoordinate {
  row: number
  column: number
}

function coordinateOf(unit: TranslationUnit): CellCoordinate {
  const metadata = unit.metadata as { row?: unknown; column?: unknown } | undefined
  const row = Number(metadata?.row)
  const column = Number(metadata?.column)
  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    throw new Error(`翻译单元 ${unit.unitId} 缺少单元格坐标，拒绝回写以免写错位置`)
  }
  return { row, column }
}

/**
 * Translate the whole active sheet in place.
 *
 * Returns the shared pipeline's result verbatim so the caller can report
 * `completed` / `failed` / `cancelled` without re-deriving them. A cancelled
 * run writes nothing at all.
 */
export async function translateSheetDocument(
  deps: SheetTranslateDeps,
  options: SheetTranslateOptions,
): Promise<TranslateDocumentResult> {
  const { sheet } = deps
  const cells = extractSheetTextCells(sheet)
  const units = sheetCellsToUnits(cells, sheet.getSheetId())
  const mode: TranslateApplyMode = options.applyMode ?? 'replace'
  // 0-based last row/column → counts. Read before the apply so a bilingual
  // column lands to the right of the block the run actually started from.
  const usedColumns = Math.max(sheet.getLastColumn() + 1, 0)

  return translateDocument(
    {
      units,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      preserveFormat: options.preserveFormat,
      scene: options.scene ?? 'sheet-document',
      memoryEnabled: options.memoryEnabled,
      qualityCheck: options.qualityCheck,
      glossaryCategory: options.glossaryCategory,
      applyMode: mode,
    },
    {
      translateBatch: deps.translateBatch,
      // `exactOptionalPropertyTypes` is on in this app, so an absent callback
      // has to be *absent* — passing `onProgress: undefined` is a type error,
      // not an equivalent value.
      ...(options.signal ? { signal: options.signal } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      apply: deps.apply ?? (({ units: settled }) => {
        applySheetTranslations(sheet, settled, mode, usedColumns)
      }),
    },
  )
}


/**
 * Write settled translations into the sheet.
 *
 * Exported so the review-then-apply UI can do the same write the pipeline
 * would have done inline, from a *second* pass: the dialog runs the pipeline
 * with a no-op `apply` so the user can review each cell first, and only the
 * dialog's Apply calls this. Two implementations of "where does a translation
 * go" is exactly the kind of duplication that produces a bilingual column on
 * the wrong side after one of them drifts, so both call this one.
 *
 * `usedColumns` is the 0-based width of the occupied block at *extraction*
 * time; pass it unchanged from the run that produced `units`, or a bilingual
 * write will land inside the data instead of beside it.
 */
export function applySheetTranslations(
  sheet: SheetTranslateWorksheet,
  units: readonly TranslationUnit[],
  mode: TranslateApplyMode,
  usedColumns: number,
): void {
  for (const unit of units) {
    const { row, column } = coordinateOf(unit)
    const translated = (unit as { translatedText?: string }).translatedText
    if (typeof translated !== 'string') continue
    const target = mode === 'bilingual' ? planSheetBilingualColumn(column, usedColumns) : column
    sheet.getRange(row, target, 1, 1).setValue({ v: translated })
  }
}

/** 0-based width of the sheet's occupied block, for {@link applySheetTranslations}. */
export function sheetUsedColumns(sheet: SheetTranslateWorksheet): number {
  return Math.max(sheet.getLastColumn() + 1, 0)
}
