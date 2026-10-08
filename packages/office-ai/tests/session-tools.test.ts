import { describe, expect, it } from 'vitest'
import { convert, readDocument } from '../src/documents'
import { openSession, type DocumentSession } from '../src/session'
import { OFFICE_TOOL_NAMES, officeTools } from '../src/tools'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)

/** A workbook with a known two-row sheet, built through the engine itself. */
const stockWorkbook = () => convert(enc('name,qty\nApple,3\nPear,7\n'), 'csv', 'xlsx', { title: 'Stock' })

const byName = (box: ReturnType<typeof officeTools>) =>
  Object.fromEntries(box.tools.map((t) => [t.name, t])) as Record<string, (typeof box.tools)[number]>

describe('DocumentSession', () => {
  it('keeps a document open across reads, edits and saves', async () => {
    const session = await openSession(await stockWorkbook())
    expect(session.format).toBe('xlsx')
    expect((await session.read()).sheet?.name).toBe('Stock')

    const after = await session.edit([
      { op: 'set_cell', sheet: 'Stock', address: 'B4', value: '99' },
    ])
    expect(after.text).toContain('99')

    // the edit is held, so a later read still sees it — and the original bytes are untouched
    expect((await session.read()).text).toContain('99')
    expect(dec(await session.save('csv'))).toContain('99')
  })

  it('converts on save without disturbing the session format', async () => {
    const session = await openSession(await stockWorkbook())
    const csv = await session.save('csv')
    expect(dec(csv)).toContain('Apple')
    expect(session.format).toBe('xlsx')
    expect(dec(session.bytes())).not.toContain('Apple')
  })

  it('rejects an empty document', async () => {
    await expect(openSession(new Uint8Array())).rejects.toMatchObject({ code: 'OFFICE_BAD_INPUT' })
  })
})

describe('officeTools', () => {
  it('ships a stable set of names', () => {
    const box = officeTools()
    expect(box.tools.map((t) => t.name)).toEqual([...OFFICE_TOOL_NAMES])
    for (const tool of box.tools) {
      expect(tool.parameters.type).toBe('object')
      expect(tool.description.length).toBeGreaterThan(20)
    }
  })

  it('honours `only`', () => {
    const box = officeTools({ only: ['read_document', 'apply_ops', 'nope'] })
    expect(box.tools.map((t) => t.name)).toEqual(['read_document', 'apply_ops'])
  })

  it('reports an error result instead of throwing when nothing is open', async () => {
    const read = byName(officeTools()).read_document
    const result = await read.execute()
    expect(result.data?.error).toMatchObject({ code: 'OFFICE_BAD_INPUT' })
    expect(result.text).toContain('no document is open')
  })

  it('drives a workbook: context, range, write, find, aggregate', async () => {
    const box = officeTools()
    await box.open(await stockWorkbook())
    const tool = byName(box)

    const context = await tool.get_document_context.execute()
    expect(context.text).toContain('workbook: 1 sheet(s) [Stock]')

    const range = await tool.read_range.execute({ range: 'A1:B3' })
    expect(range.text).toContain('Apple\t3')

    const written = await tool.set_cells.execute({
      cells: [{ address: 'B4', value: '10' }, { address: 'B5', value: '=SUM(B2:B4)' }],
    })
    expect(written.data).toMatchObject({ written: 2 })

    const found = await tool.find_cells.execute({ query: 'pea' })
    expect(found.data).toMatchObject({ cells: ['A3'] })

    const total = await tool.aggregate_range.execute({ op: 'sum', range: 'B2:B4' })
    expect(total.data).toMatchObject({ op: 'sum', result: 20 })
  })

  it('exports a converted file from the open document', async () => {
    const box = officeTools()
    await box.open(await stockWorkbook())
    const result = await byName(box).convert_document.execute({ to: 'csv' })

    expect(result.files?.[0]?.name).toBe('document.csv')
    expect(result.files?.[0]?.mimeType).toBe('text/csv')
    expect(dec(result.files![0]!.bytes)).toContain('Apple')
  })

  it('maps a refusal onto the result rather than throwing', async () => {
    const box = officeTools()
    await box.open(await stockWorkbook())
    // xlsx→pdf is an app-renderer route, so it is reported rather than converted
    const result = await byName(box).convert_document.execute({ to: 'pdf' })
    expect(result.data?.error).toMatchObject({ code: 'OFFICE_NEEDS_APP' })
    expect(result.text).toContain('needs an app renderer')
  })

  it('edits a docx through the tool layer', async () => {
    const box = officeTools()
    await box.open(await convert(enc('# 报告\n\n第一段。\n'), 'md', 'docx'))
    const tool = byName(box)

    const context = await tool.get_document_context.execute()
    expect(context.text).toContain('docx:')

    const blocks = await tool.read_blocks.execute({ startBlockIndex: 0, endBlockIndex: 4 })
    expect(blocks.text).toContain('报告')

    const inserted = await tool.insert_content.execute({ html: '<p>新增段落。</p>' })
    expect(Number(inserted.data?.blocks)).toBeGreaterThan(Number(blocks.data?.blockCount))

    const replaced = await tool.replace_blocks.execute({
      startBlockIndex: 0,
      endBlockIndex: 0,
      html: '<h1>重写标题</h1>',
    })
    expect(replaced.text).toContain('Replaced blocks 0–0')

    const md = await box.save('md')
    expect(dec(md)).toContain('重写标题')
    expect(dec(md)).toContain('新增段落')
  })

  it('replaces the whole body through replace_document', async () => {
    const box = officeTools()
    await box.open(await convert(enc('# One\n\nTwo\n'), 'md', 'docx'))
    const result = await byName(box).replace_document.execute({ html: '<p>Only this.</p>' })

    expect(result.data?.blocks).toBe(1)
    const md = dec(await box.save('md'))
    expect(md).toContain('Only this')
    expect(md).not.toContain('Two')
  })

  it('applies formatting ops through apply_ops', async () => {
    const box = officeTools()
    await box.open(await convert(enc('# Heading\n\nBody text.\n'), 'md', 'docx'))
    const result = await byName(box).apply_ops.execute({
      ops: [{ op: 'setHeadingLevel', target: { blockIndexes: [0] }, level: 2 }],
    })
    expect(result.data?.error).toBeUndefined()
    expect(result.text).toContain('Applied 1 op(s)')
  })
})

describe('officeTools — session handoff', () => {
  it('exposes the live session for a host that wants bytes', async () => {
    const box = officeTools()
    await box.open(await stockWorkbook())
    const session = box.session() as DocumentSession
    expect(session.format).toBe('xlsx')
    expect((await readDocument(session.bytes())).kind).toBe('sheet')
  })
})
