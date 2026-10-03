import { describe, expect, it } from 'vitest'
import {
  applySheetTranslations,
  extractSheetTextCells,
  isTranslatableCellText,
  MAX_TRANSLATE_CELL_CHARS,
  parseSheetUnitId,
  planSheetBilingualColumn,
  sheetCellsToUnits,
  translateSheetDocument,
  type SheetCellLike,
  type SheetTranslateWorksheet,
} from '../src/renderer/ai/document-translate'
import type { TranslateBatchRequest, TranslateBatchResponse } from '@genoffice/translation-core/document'

/** Minimal in-memory stand-in for the Univer sheet slice. */
function fakeSheet(cells: Array<[number, number, SheetCellLike | null]>, lastRow: number, lastColumn: number) {
  const writes: Array<{ row: number; column: number; value: unknown }> = []
  const sheet: SheetTranslateWorksheet = {
    getLastRow: () => lastRow,
    getLastColumn: () => lastColumn,
    getSheetId: () => 'sheet-1',
    getSheetName: () => 'Sheet1',
    getRange: (row, column) => ({
      setValue: (value) => writes.push({ row, column, value }),
    }),
    getSheet: () => ({
      getCellMatrix: () => ({
        forValue: (callback) => {
          for (const [row, column, cell] of cells) callback(row, column, cell)
        },
      }),
    }),
  }
  return { sheet, writes }
}

/** Transport that upper-cases every unit, so a write shows up as an obvious change. */
const upperTransport = async (request: TranslateBatchRequest): Promise<TranslateBatchResponse> => ({
  ok: true,
  units: request.units.map((unit) => ({
    unitId: unit.unitId,
    sourceText: unit.sourceText,
    translatedText: unit.sourceText.toUpperCase(),
    status: 'translated' as const,
  })),
})

describe('isTranslatableCellText', () => {
  it('accepts plain text', () => {
    expect(isTranslatableCellText({ v: 'hello' })).toBe(true)
  })

  it('rejects a formula cell even when it also carries display text', () => {
    // The whole point: replacing a formula's display text with a constant
    // silently breaks every downstream reference.
    expect(isTranslatableCellText({ v: '=SUM(A1:A9)', f: '=SUM(A1:A9)' })).toBe(false)
  })

  it('rejects numbers, booleans, blanks and nulls', () => {
    expect(isTranslatableCellText({ v: 42 })).toBe(false)
    expect(isTranslatableCellText({ v: true })).toBe(false)
    expect(isTranslatableCellText({ v: '   ' })).toBe(false)
    expect(isTranslatableCellText(null)).toBe(false)
  })

  it('rejects an over-long dump rather than paying to translate it', () => {
    expect(isTranslatableCellText({ v: 'x'.repeat(MAX_TRANSLATE_CELL_CHARS + 1) })).toBe(false)
    expect(isTranslatableCellText({ v: 'x'.repeat(MAX_TRANSLATE_CELL_CHARS) })).toBe(true)
  })
})

describe('extractSheetTextCells', () => {
  it('keeps only translatable cells and their coordinates', () => {
    const { sheet } = fakeSheet(
      [
        [0, 0, { v: 'Name' }],
        [0, 1, { v: 100 }],
        [1, 0, { v: '=A1' , f: '=A1' }],
        [1, 1, { v: 'Alice' }],
      ],
      1,
      1,
    )
    expect(extractSheetTextCells(sheet)).toEqual([
      { row: 0, column: 0, text: 'Name' },
      { row: 1, column: 1, text: 'Alice' },
    ])
  })

  it('throws instead of silently truncating a huge sheet', () => {
    const cells: Array<[number, number, SheetCellLike]> = []
    for (let i = 0; i < 20_001; i += 1) cells.push([i, 0, { v: `cell ${i}` }])
    const { sheet } = fakeSheet(cells, 20_000, 0)
    expect(() => extractSheetTextCells(sheet)).toThrow(/超过/)
  })
})

describe('sheetCellsToUnits', () => {
  it('carries the cell coordinates so apply cannot re-derive them', () => {
    const units = sheetCellsToUnits([{ row: 3, column: 7, text: 'Total' }], 'sheet-1')
    expect(units[0]).toMatchObject({
      unitId: 'sheet-1!3:7',
      order: 0,
      kind: 'table-cell',
      sourceText: 'Total',
      metadata: { row: 3, column: 7, sheetId: 'sheet-1' },
    })
  })
})

describe('planSheetBilingualColumn', () => {
  it('offsets by the used width so it can never overwrite existing data', () => {
    // Used block is columns 0..2, so source column 1 would land on 2 — which
    // holds real data. The rule puts it at 3 + 1 = 4 instead.
    expect(planSheetBilingualColumn(1, 3)).toBe(4)
    expect(planSheetBilingualColumn(0, 3)).toBe(3)
  })

  it('is injective: two source columns never share an output column', () => {
    const used = 5
    const outputs = [0, 1, 2, 3, 4].map((column) => planSheetBilingualColumn(column, used))
    expect(new Set(outputs).size).toBe(outputs.length)
  })
})

describe('translateSheetDocument', () => {
  it('replace mode writes translations back into the source cells', async () => {
    const { sheet, writes } = fakeSheet(
      [
        [0, 0, { v: 'hello' }],
        [0, 1, { v: 7 }],
      ],
      0,
      1,
    )
    const result = await translateSheetDocument({ sheet, translateBatch: upperTransport }, {
      targetLang: 'zh-CN',
    })
    expect(result.status).toBe('completed')
    expect(writes).toEqual([{ row: 0, column: 0, value: { v: 'HELLO' } }])
  })

  it('bilingual mode writes to the offset column, never onto the source', async () => {
    const { sheet, writes } = fakeSheet(
      [
        [0, 0, { v: 'hello' }],
        [0, 1, { v: 'world' }],
      ],
      0,
      1,
    )
    const result = await translateSheetDocument({ sheet, translateBatch: upperTransport }, {
      targetLang: 'zh-CN',
      applyMode: 'bilingual',
    })
    expect(result.status).toBe('completed')
    expect(result.mode).toBe('bilingual')
    // usedColumns = 2, so column 0 → 2 and column 1 → 3.
    expect(writes).toEqual([
      { row: 0, column: 2, value: { v: 'HELLO' } },
      { row: 0, column: 3, value: { v: 'WORLD' } },
    ])
  })

  it('never writes to a formula cell', async () => {
    const { sheet, writes } = fakeSheet([[0, 0, { v: '=A1', f: '=A1' }]], 0, 0)
    const result = await translateSheetDocument({ sheet, translateBatch: upperTransport }, {
      targetLang: 'zh-CN',
    })
    expect(result.status).toBe('completed')
    expect(writes).toEqual([])
  })

  it('reports provider failure instead of reporting an empty success', async () => {
    const { sheet, writes } = fakeSheet([[0, 0, { v: 'hello' }]], 0, 0)
    const result = await translateSheetDocument(
      {
        sheet,
        translateBatch: async () => {
          throw new Error('provider 额度不足')
        },
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('额度不足')
    expect(writes).toEqual([])
  })

  it('a cancelled run writes nothing', async () => {
    const { sheet, writes } = fakeSheet([[0, 0, { v: 'hello' }]], 0, 0)
    const controller = new AbortController()
    controller.abort()
    const result = await translateSheetDocument(
      { sheet, translateBatch: upperTransport },
      { targetLang: 'zh-CN', signal: controller.signal },
    )
    expect(result.status).toBe('cancelled')
    expect(writes).toEqual([])
  })

  it('an empty sheet completes without calling the provider', async () => {
    const { sheet, writes } = fakeSheet([], 0, 0)
    let called = false
    const result = await translateSheetDocument(
      {
        sheet,
        translateBatch: async (request) => {
          called = true
          return { ok: true, units: request.units.map((unit) => ({ unitId: unit.unitId, sourceText: unit.sourceText, translatedText: '', status: 'translated' as const })) }
        },
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('completed')
    expect(called).toBe(false)
    expect(writes).toEqual([])
  })
})

describe('parseSheetUnitId', () => {
  it('round-trips the id minted by sheetCellsToUnits', () => {
    const units = sheetCellsToUnits([{ row: 5, column: 2, text: 'x' }], 'my sheet')
    expect(parseSheetUnitId(units[0]!.unitId)).toEqual({ sheetId: 'my sheet', row: 5, column: 2 })
  })

  it('rejects an id that is not one of ours', () => {
    expect(parseSheetUnitId('nonsense')).toBeNull()
    expect(parseSheetUnitId('!1:2')).toBeNull()
    expect(parseSheetUnitId('sheet!a:b')).toBeNull()
    expect(parseSheetUnitId('sheet!1:2:3')).toBeNull()
  })
})

describe('applySheetTranslations', () => {
  const units = [
    { unitId: 'Products!0:0', kind: 'table-cell' as const, sourceText: 'Product Name', order: 0, metadata: { row: 0, column: 0 }, translatedText: 'T-Product Name' },
    { unitId: 'Products!0:1', kind: 'table-cell' as const, sourceText: 'Widget', order: 1, metadata: { row: 0, column: 1 }, translatedText: 'T-Widget' },
    { unitId: 'Products!0:2', kind: 'table-cell' as const, sourceText: 'Unit Price', order: 2, metadata: { row: 0, column: 2 }, translatedText: 'T-Unit Price' },
    { unitId: 'Products!1:0', kind: 'table-cell' as const, sourceText: 'Widget', order: 3, metadata: { row: 1, column: 0 }, translatedText: 'T-Widget-2' },
    { unitId: 'Products!2:0', kind: 'table-cell' as const, sourceText: 'Shipping Address', order: 4, metadata: { row: 2, column: 0 }, translatedText: 'T-Shipping' },
    { unitId: 'Products!2:1', kind: 'table-cell' as const, sourceText: 'Springfield', order: 5, metadata: { row: 2, column: 1 }, translatedText: 'T-Springfield' },
  ]

  it('每一个 unit 都写回，一个都不漏', () => {
    // 端到端实测过：6 个单元格全部翻译成功、Quality 100%，但保存后的工作簿里
    // 只有 A1 变成了译文。这条判据把「循环只跑了第一条」这类退化钉在纯逻辑层。
    const { sheet, writes } = fakeSheet([], 2, 2)
    applySheetTranslations(sheet, units, 'replace', 3)
    expect(writes.map((w) => [w.row, w.column, (w.value as { v: string }).v])).toEqual([
      [0, 0, 'T-Product Name'],
      [0, 1, 'T-Widget'],
      [0, 2, 'T-Unit Price'],
      [1, 0, 'T-Widget-2'],
      [2, 0, 'T-Shipping'],
      [2, 1, 'T-Springfield'],
    ])
  })

  it('bilingual 把每个单元格的译文写到同一行的相邻新列', () => {
    const { sheet, writes } = fakeSheet([], 2, 2)
    applySheetTranslations(sheet, units, 'bilingual', 3)
    expect(writes.map((w) => [w.row, w.column])).toEqual([
      [0, 3],
      [0, 4],
      [0, 5],
      [1, 3],
      [2, 3],
      [2, 4],
    ])
  })

  it('译文不是字符串的 unit 被跳过，不写入 undefined', () => {
    const { sheet, writes } = fakeSheet([], 2, 2)
    // `translatedText` 不在 `TranslationUnit` 的共享 vocabulary 里，生产代码也是
    // 先收窄再读；这里照同一形状构造，避免测试自己比生产更宽松。
    const withoutTranslation = { ...units[0]!, translatedText: undefined } as unknown as Parameters<
      typeof applySheetTranslations
    >[1][number]
    applySheetTranslations(sheet, [withoutTranslation], 'replace', 3)
    expect(writes).toEqual([])
  })
})
