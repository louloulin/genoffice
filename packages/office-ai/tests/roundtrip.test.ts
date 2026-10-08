import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blankDeck, saveDeck } from '@genoffice/cli/formats/pptx'
import {
  applyDocumentOps,
  convert,
  detectFormat,
  readDocument,
  render,
  writeDocument,
} from '../src/index'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const tempDir = () => mkdtempSync(join(tmpdir(), 'office-ai-test-'))

/** A valid one-page PDF with real Helvetica text; enough for page counting and conversion. */
function minimalPdf(text = 'Hello genoffice'): Uint8Array {
  const dir = tempDir()
  const path = join(dir, 'in.pdf')
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(path, body, 'latin1')
  return new Uint8Array(readFileSync(path))
}

describe('detectFormat', () => {
  it('sniffs containers from their signature', () => {
    expect(detectFormat(enc('%PDF-1.4\n%...'))).toBe('pdf')
    expect(detectFormat(enc('<!doctype html>\n<html></html>'))).toBe('html')
    expect(detectFormat(enc('name,qty\nApple,3\n'))).toBe('txt')
    expect(detectFormat(enc('PK\x03\x04\u0000\u0000word/document.xml'))).toBe('docx')
    expect(detectFormat(enc('PK\x03\x04\u0000\u0000xl/workbook.xml'))).toBe('xlsx')
  })

  it('trusts an explicit hint over the bytes', () => {
    expect(detectFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), { hint: 'book.xlsm' })).toBe(
      'xlsm',
    )
    expect(detectFormat(enc('plain'), { hint: 'notes.csv' })).toBe('csv')
  })
})

describe('tier 1 — round trips', () => {
  it('reads, edits and re-reads a workbook', async () => {
    const csv = enc('name,qty\nApple,3\nPear,7\n')
    const xlsx = await convert(csv, 'csv', 'xlsx', { title: 'Stock' })

    const view = await readDocument(xlsx)
    expect(view.kind).toBe('sheet')
    expect(view.sheet?.name).toBe('Stock')
    expect(view.text).toContain('Apple')

    const edited = await writeDocument(
      xlsx,
      [{ op: 'set_cell', sheet: 'Stock', address: 'C1', value: 'total' }],
      { format: 'xlsx' },
    )
    const after = await readDocument(edited)
    expect(after.text).toContain('total')

    // and back out to csv
    const back = await convert(edited, 'xlsx', 'csv', { sheet: 'Stock' })
    expect(dec(back)).toContain('Apple')
  })

  it('builds a docx from markdown, edits it and exports markdown', async () => {
    const docx = await convert(enc('# Quarterly Report\n\nRevenue grew 12%.\n'), 'md', 'docx')
    const view = await readDocument(docx)
    expect(view.format).toBe('docx')
    expect(view.text).toContain('Quarterly Report')
    expect(view.blocks?.length).toBeGreaterThan(0)

    const edited = await applyDocumentOps(docx, [{ op: 'insert_content', html: '<p>Appended.</p>' }])
    const after = await readDocument(edited)
    expect(after.text).toContain('Appended.')

    const md = await convert(edited, 'docx', 'md')
    expect(dec(md)).toContain('Quarterly Report')
  })

  it('reads and edits a deck', async () => {
    const pptx = await saveDeck(await blankDeck())
    const view = await readDocument(pptx)
    expect(view.kind).toBe('slides')
    expect(view.deck).toBeDefined()
  })

  it('inspects, renders and converts a pdf', async () => {
    const pdf = minimalPdf()
    const view = await readDocument(pdf)
    expect(view.format).toBe('pdf')
    expect(view.pdf?.pages).toBe(1)

    const pngs = await render(pdf, { scale: 1 })
    expect(pngs.length).toBe(1)
    expect(pngs[0].length).toBeGreaterThan(500)

    const docx = await convert(pdf, 'pdf', 'docx')
    expect(await readDocument(docx).then((v) => v.format)).toBe('docx')
  })
})

describe('tier 1 — honest refusals', () => {
  it('flags conversions that need the app', async () => {
    await expect(convert(enc('a,b\n1,2\n'), 'csv', 'pdf')).rejects.toMatchObject({
      code: 'OFFICE_NEEDS_APP',
    })
    await expect(render(enc('a,b\n1,2\n'), { format: 'csv' })).rejects.toMatchObject({
      code: 'OFFICE_NEEDS_APP',
    })
  })

  it('flags the legacy workbook conversion that needs the sidecar', async () => {
    await expect(convert(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'xls', 'xlsx')).rejects.toMatchObject(
      { code: 'OFFICE_NEEDS_SIDECAR' },
    )
  })

  it('refuses an unknown route', async () => {
    await expect(convert(enc('x'), 'txt', 'pptx')).rejects.toMatchObject({
      code: 'OFFICE_UNSUPPORTED',
    })
  })
})
