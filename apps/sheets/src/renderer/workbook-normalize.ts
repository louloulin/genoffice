/**
 * Workbook-model normalization applied on every open.
 *
 * `worksheetMetadataSchema` gives `pivotTables` / `sparklines` / `cellImages` a
 * `.default([])`, but that default only materialises on the paths that actually
 * run the schema — a workbook opened from an upload (or produced by an older
 * writer) reaches the model with the fields simply absent, while the TypeScript
 * type still says "always an array" because it is inferred from the schema.
 *
 * The mismatch is not cosmetic. Every unguarded `sheet.sparklines.length`
 * downstream is then a `TypeError` thrown **inside a Univer command handler**,
 * and Univer's facade lets it escape through `FRange.setValue`. The edit that
 * triggered it is journaled, then every write after it in the same loop never
 * runs: a whole-worksheet translation silently landed one translated cell out
 * of six, and the UI reported success. That is the worst failure shape there
 * is — no error, no partial marker, just missing translations.
 *
 * So the invariant is established once, here, at the single place every opened
 * workbook passes through (`openLazyWorkbook`), instead of guarding each of the
 * ~10 read sites individually.
 */
import type { WorkbookFile } from '../shared/desktop-api'

/** Sheet-metadata arrays the schema defaults to `[]` but a file may omit. */
const DEFAULTED_SHEET_ARRAYS = ['pivotTables', 'sparklines', 'cellImages'] as const

export function withSheetMetaDefaults(file: WorkbookFile): WorkbookFile {
  return {
    ...file,
    sheets: file.sheets.map((sheet) => {
      let changed = false
      const patch: Record<string, unknown[]> = {}
      for (const field of DEFAULTED_SHEET_ARRAYS) {
        const value = (sheet as unknown as Record<string, unknown>)[field]
        if (!Array.isArray(value)) {
          patch[field] = []
          changed = true
        }
      }
      return changed ? { ...sheet, ...patch } : sheet
    }),
  }
}
