import { describe, expect, it } from 'vitest'
import { convert, readDocument, writeDocument } from '../src/documents'
import { OfficeError } from '../src/errors'
import { openDocsFile, openSheetsFile } from '../src/file-editor'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

const report = () => convert(enc('# Quarterly\n\nRevenue up 12%.\n'), 'md', 'docx')
const stockWorkbook = () =>
  convert(enc('name,qty\nApple,3\nPear,7\n'), 'csv', 'xlsx', { title: 'Stock' })

describe('openDocsFile', () => {
  it('reads a document through the editor contract', async () => {
    const file = await openDocsFile(await report())
    try {
      const { editor } = file
      expect(editor.getBlockCount()).toBe(2)

      const heading = editor.getBlock(0)
      expect(heading.index).toBe(0)
      expect(heading.kind).toBe('heading')
      expect(heading.html).toContain('Quarterly')
      expect(heading.trackedDeleted).toBeUndefined()

      expect(editor.getRangeHtml(0, 1)).toContain('Revenue')
      expect(editor.clampRange(0, 1)).toEqual({ start: 0, end: 1 })
      // out-of-range requests are normalized onto the document, not rejected
      expect(editor.clampRange(4, 9)).toEqual({ start: 1, end: 1 })
      expect(editor.clampRange(1, 0)).toBeNull()
      expect(editor.clampRange(0.5, 1)).toBeNull()

      expect(() => editor.getBlock(2)).toThrowError(/out of range/)
      expect(() => editor.getRangeHtml(1, 0)).toThrowError(/invalid/)
    } finally {
      file.close()
    }
  })

  it('edits blocks and writes them back on save', async () => {
    const file = await openDocsFile(await report())
    const { editor } = file

    expect(editor.insertBlocks(0, '<p>补充说明。</p>')).toEqual({ inserted: 1 })
    expect(editor.getBlockCount()).toBe(3)
    expect(editor.getBlock(1).html).toContain('补充说明')

    // -1 inserts before the first block
    expect(editor.insertBlocks(-1, '<p>摘要。</p>')).toEqual({ inserted: 1 })
    expect(editor.getBlock(0).html).toContain('摘要')

    expect(editor.replaceBlockRange(1, 1, '<h2>Renamed</h2>')).toEqual({
      inserted: 1,
      removed: 1,
    })
    expect(editor.getBlock(1).html).toContain('Renamed')

    // no user selection headless, so a selection rewrite reports that it did nothing
    expect(editor.replaceSelection('<b>x</b>')).toEqual({ replaced: false })
    editor.markDocSeen()

    expect(() => editor.insertBlocks(9, '<p>x</p>')).toThrowError(/out of range/)
    expect(() => editor.insertBlocks(0, '   ')).toThrowError(/no content/)

    const saved = await file.save()
    const view = await readDocument(saved)
    expect(view.text).toContain('摘要')
    expect(view.text).toContain('Renamed')
    expect(view.text).toContain('补充说明')
    file.close()
  })

  it('applies op batches atomically, and validates them on a dry run', async () => {
    const file = await openDocsFile(await report())
    const { editor } = file

    const op = { op: 'setHeadingLevel', target: { blockIndexes: [0] }, level: 3 }
    expect(editor.applyOps([op], true)).toEqual({ applied: 0, dryRun: true })
    expect(file.blocks()[0]?.level).toBe(1)

    expect(editor.applyOps([op], false)).toEqual({ applied: 1, dryRun: false })
    expect(file.blocks()[0]?.level).toBe(3)

    // one bad op refuses the whole batch and leaves the document alone
    const before = file.html()
    expect(() => editor.applyOps([op, { op: 'nope' }], false)).toThrowError(/unknown op/)
    expect(file.html()).toBe(before)
    file.close()
  })

  it('serializes to markdown and rejects an empty input', async () => {
    const file = await openDocsFile(await report())
    const bytes = await file.save()
    expect(dec(await convert(bytes, 'docx', 'md'))).toContain('Quarterly')
    // saving twice is fine: the file stays open
    expect((await file.save()).byteLength).toBe(bytes.byteLength)
    file.close()

    await expect(openDocsFile(new Uint8Array())).rejects.toMatchObject({
      code: 'OFFICE_BAD_INPUT',
    })
  })
})

describe('openSheetsFile', () => {
  it('reads a workbook through the editor contract', async () => {
    const file = await openSheetsFile(await stockWorkbook())
    const { editor } = file

    expect(editor.getWorkbookSummary()).toEqual({
      sheetNames: ['Stock'],
      activeSheet: 'Stock',
      totalCells: 6,
      totalFormulas: 0,
    })

    const grid = editor.readRange({
      sheet: 'Stock',
      startRow: 0,
      endRow: 2,
      startCol: 0,
      endCol: 1,
    })
    expect(grid[0]).toEqual([{ raw: 'name' }, { raw: 'qty' }])
    expect(grid[1]).toEqual([{ raw: 'Apple' }, { raw: 3 }])
    expect(grid[2]).toEqual([{ raw: 'Pear' }, { raw: 7 }])
  })

  it('aggregates, searches and reports features', async () => {
    const file = await openSheetsFile(await stockWorkbook())
    const { editor } = file
    const qty = { sheet: 'Stock', startRow: 1, endRow: 2, startCol: 1, endCol: 1 }

    expect(editor.aggregateRange(qty, 'sum')).toBe(10)
    expect(editor.aggregateRange(qty, 'avg')).toBe(5)
    expect(editor.aggregateRange(qty, 'count')).toBe(2)
    expect(editor.aggregateRange(qty, 'min')).toBe(3)
    expect(editor.aggregateRange(qty, 'max')).toBe(7)
    // a range with no numbers aggregates to nothing rather than to 0
    expect(editor.aggregateRange({ ...qty, startCol: 0, endCol: 0 }, 'sum')).toBeNull()

    expect(editor.findCells('Stock', 'pp')).toEqual(['A2'])
    expect(editor.findCells('Stock', 'Apple')).toEqual(['A2'])
    expect(editor.findCells('Stock', 'zzz')).toEqual([])

    expect(editor.getSheetFeatures('Stock')).toEqual({ mergedRanges: [], frozenPanes: null })
    expect(() => editor.readRange({ ...qty, sheet: 'Nope' })).toThrowError(/no worksheet/)
    file.close()
  })

  it('rejects an empty input', async () => {
    await expect(openSheetsFile(new Uint8Array())).rejects.toMatchObject({
      code: 'OFFICE_BAD_INPUT',
    })
  })
})

describe('malformed input', () => {
  // A parser reports a bad container in its own words and with no `code`; the
  // library promises a code a host can branch on, so it normalizes them.
  it('normalizes a truncated docx to OFFICE_INTERNAL with the cause kept', async () => {
    const bad = enc('PK\u0003\u0004 nope, not really a zip')
    const err = await readDocument(bad, { format: 'docx' }).catch((e) => e)
    expect(err).toBeInstanceOf(OfficeError)
    expect(err.code).toBe('OFFICE_INTERNAL')
    expect(err.detail?.context).toMatch(/read \.docx/)
    expect(err.cause).toBeInstanceOf(Error)

    await expect(openDocsFile(bad)).rejects.toMatchObject({ code: 'OFFICE_INTERNAL' })
  })

  it('normalizes a non-workbook to OFFICE_INTERNAL rather than leaking a zip error', async () => {
    const bad = enc('this is plainly not a workbook')
    await expect(openSheetsFile(bad)).rejects.toMatchObject({ code: 'OFFICE_INTERNAL' })
    await expect(readDocument(bad, { format: 'xlsx' })).rejects.toMatchObject({
      code: 'OFFICE_INTERNAL',
    })
  })

  // The engine rejects a bad op batch with a usage error; a host asked to correct
  // its request, not to file a bug, so it must not read as an engine fault.
  it('reports a rejected op batch as OFFICE_BAD_INPUT, not an internal fault', async () => {
    const docx = await report()
    await expect(
      writeDocument(docx, [{ op: 'no_such_op' }], { format: 'docx' }),
    ).rejects.toMatchObject({ code: 'OFFICE_BAD_INPUT' })
    await expect(
      writeDocument(docx, [{ op: 'setHeadingLevel', target: {}, level: 3 }], { format: 'docx' }),
    ).rejects.toMatchObject({ code: 'OFFICE_BAD_INPUT' })
  })
})
