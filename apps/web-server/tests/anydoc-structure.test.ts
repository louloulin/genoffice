import { Buffer } from 'node:buffer'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

// Re-route DATA_DIR before importing the handler so the Web temp state
// in `tmp/genoffice-data` doesn't pollute the test filesystem.
const ORIGINAL_ENV = { ...process.env }
const TEST_DATA_DIR = `/tmp/genoffice-anydoc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
process.env.DATA_DIR = TEST_DATA_DIR

const { registerAnydocHandlers } = await import('../src/anydoc/index')
const { registerHandle, getHandler, FILES_DIR, DOCS_RECENT } = await import('../src/common/index')
const { mkdirSync, rmSync, writeFileSync } = await import('node:fs')
const { join } = await import('node:path')

mkdirSync(TEST_DATA_DIR, { recursive: true })
mkdirSync(FILES_DIR, { recursive: true })
registerAnydocHandlers()

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

function buildDocx(body: string): Buffer {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/styles.xml',
    `${XML_DECL}<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
      '</w:style>',
  )
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as unknown as Promise<Buffer> as never
}

async function docxWithTable(): Promise<Buffer> {
  const body =
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>' +
    '</w:tr><w:tr>' +
    '<w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>'
  return await buildDocx(body)
}

async function docxWithImage(): Promise<Buffer> {
  const TINY_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const body =
    `<w:p><w:r><w:drawing>` +
    `<wp:inline distT="0" distB="0" distL="0" distR="0" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
    `<wp:extent cx="1828800" cy="1828800"/>` +
    `<wp:docPr id="1" name="Picture 1"/>` +
    `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
    `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:blipFill><a:blip r:embed="rIdImg" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></pic:blipFill>` +
    `</pic:pic></a:graphicData></a:graphic>` +
    `</wp:inline></w:drawing></w:r></w:p>`
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Default Extension="png" ContentType="image/png"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>',
  )
  zip.file(
    '_rels/.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      '<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' +
      '</Relationships>',
  )
  zip.file(
    'word/document.xml',
    `${XML_DECL}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  )
  zip.file('word/media/image1.png', Buffer.from(TINY_PNG_BASE64, 'base64'))
  return (await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })) as Buffer
}

describe('anydoc:extract-tables', () => {
  it('extracts a real DOCX table through the channel', async () => {
    const bytes = await docxWithTable()
    const path = join(FILES_DIR, 'real-table.docx')
    writeFileSync(path, bytes)
    const handler = getHandler('anydoc:extract-tables')
    expect(handler).toBeDefined()
    const result = (await handler!(null, path)) as {
      tables: Array<{ rows: string[][]; blockId: string; label?: string }>
      unsupported: boolean
      error?: string
    }
    expect(result.unsupported).toBe(false)
    expect(result.tables).toHaveLength(1)
    expect(result.tables[0].rows).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ])
    expect(result.tables[0].blockId).toBeTruthy()
    expect(result.tables[0].label).toBe('Table 2×2')
    expect(result.error).toBeUndefined()
  })

  it('returns unsupported for non-docx extensions', async () => {
    const path = join(FILES_DIR, 'fake.pdf')
    writeFileSync(path, Buffer.from('not a pdf'))
    const handler = getHandler('anydoc:extract-tables')!
    const result = (await handler(null, path)) as { unsupported: boolean; error?: string }
    expect(result.unsupported).toBe(true)
    expect(result.error).toContain('pdf')
  })

  it('returns null when the path is outside managed storage', async () => {
    const handler = getHandler('anydoc:extract-tables')!
    expect(await handler(null, '/etc/passwd')).toBeNull()
  })

  it('returns null when the file does not exist', async () => {
    const handler = getHandler('anydoc:extract-tables')!
    expect(await handler(null, join(FILES_DIR, 'missing.docx'))).toBeNull()
  })
})

describe('anydoc:extract-images', () => {
  it('extracts inline DOCX images through the channel', async () => {
    const bytes = await docxWithImage()
    const path = join(FILES_DIR, 'real-image.docx')
    writeFileSync(path, bytes)
    const handler = getHandler('anydoc:extract-images')!
    const result = (await handler(null, path)) as {
      images: Array<{ dataUrl: string; widthPx?: number; heightPx?: number }>
      unsupported: boolean
      error?: string
    }
    expect(result.unsupported).toBe(false)
    expect(result.images).toHaveLength(1)
    expect(result.images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(result.images[0].widthPx).toBe(192)
    expect(result.images[0].heightPx).toBe(192)
    expect(result.error).toBeUndefined()
  })

  it('returns unsupported for pptx (not wired in this build)', async () => {
    const path = join(FILES_DIR, 'fake.pptx')
    writeFileSync(path, Buffer.from('not a pptx'))
    const handler = getHandler('anydoc:extract-images')!
    const result = (await handler(null, path)) as { unsupported: boolean; error?: string }
    expect(result.unsupported).toBe(true)
    expect(result.error).toContain('pptx')
  })

  it('surfaces parser errors instead of 500', async () => {
    const path = join(FILES_DIR, 'truncated.docx')
    // Truncated ZIP header → parseDocx throws
    writeFileSync(path, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    const handler = getHandler('anydoc:extract-images')!
    const result = (await handler(null, path)) as { unsupported: boolean; error?: string }
    expect(result.unsupported).toBe(false)
    expect(result.error).toBeTruthy()
  })
})

// Restore env + cleanup
import { afterAll } from 'vitest'
afterAll(() => {
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
  process.env = ORIGINAL_ENV
})
