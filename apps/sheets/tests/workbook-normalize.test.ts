/**
 * `withSheetMetaDefaults` — the load-time invariant that makes every unguarded
 * `sheet.<defaultedArray>.length` downstream safe.
 *
 * The failure it prevents was measured, not theorised: a whole-worksheet
 * translation of a 6-cell sheet reported success and persisted **one**
 * translated cell. The other five writes never ran, because
 * `sheet.sparklines.length` threw inside the Univer command handler and the
 * throw escapes through `FRange.setValue`, aborting the rest of the caller's
 * loop. The array was absent because the schema's `.default([])` never ran on
 * the path that opened this workbook.
 */
import { describe, expect, it } from 'vitest'
import { withSheetMetaDefaults } from '../src/renderer/workbook-normalize'
import type { WorkbookFile } from '../src/shared/desktop-api'

/** A workbook whose sheet carries none of the defaulted arrays. */
function fileWithoutDefaults(): WorkbookFile {
  return {
    sessionId: 'sess-1',
    name: 'products.xlsx',
    format: 'xlsx',
    targetPath: '/tmp/products.xlsx',
    sheetNames: new Map([['sheet-1', 'Products']]),
    sheets: [
      {
        sheetId: 'sheet-1',
        name: 'Products',
        rowCount: 3,
        columnCount: 3,
        // A file from an upload / an older writer: the fields are simply absent.
      },
    ],
    visuals: [],
  } as unknown as WorkbookFile
}

describe('withSheetMetaDefaults', () => {
  it('fills the three schema-defaulted sheet arrays when they are absent', () => {
    const file = withSheetMetaDefaults(fileWithoutDefaults())
    const sheet = file.sheets[0] as unknown as Record<string, unknown>
    expect(sheet.pivotTables).toEqual([])
    expect(sheet.sparklines).toEqual([])
    expect(sheet.cellImages).toEqual([])
  })

  it('leaves arrays that are present untouched, and does not copy the sheet', () => {
    const base = fileWithoutDefaults()
    const pivot = { path: 'xl/pivotTables/pivot1.xml' }
    // All three present → nothing to fill → the sheet must come back by identity.
    const complete = {
      ...(base.sheets[0] as object),
      pivotTables: [pivot],
      sparklines: [],
      cellImages: [],
    }
    const withData = { ...base, sheets: [complete] } as unknown as WorkbookFile
    const file = withSheetMetaDefaults(withData)
    const sheet = file.sheets[0] as unknown as Record<string, unknown>
    expect(sheet.pivotTables).toEqual([pivot])
    // Untouched sheets are returned by identity — no needless re-render churn.
    expect(file.sheets[0]).toBe(withData.sheets[0])
  })

  it('the downstream read that used to throw now evaluates', () => {
    // The exact expression from the Univer command observer.
    const file = withSheetMetaDefaults(fileWithoutDefaults())
    expect(() => file.sheets.some((sheet) => sheet.sparklines.length > 0)).not.toThrow()
  })

  it('is idempotent', () => {
    const once = withSheetMetaDefaults(fileWithoutDefaults())
    expect(withSheetMetaDefaults(once)).toEqual(once)
  })
})
