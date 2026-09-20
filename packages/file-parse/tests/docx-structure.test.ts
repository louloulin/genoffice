import { Buffer } from 'node:buffer'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { extractDocxImages, extractDocxTables } from '../src/index'
import { buildDocxFixture, TINY_PNG_BASE64, writeFixture } from './helpers/fixtures'

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

function shell(body: string): Uint8Array {
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
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}

async function docxWithTwoTables(): Promise<Uint8Array> {
  const body =
    '<w:p><w:r><w:t>Heading paragraph</w:t></w:r></w:p>' +
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc>' +
    '</w:tr><w:tr>' +
    '<w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>' +
    '<w:p><w:r><w:t>Between tables</w:t></w:r></w:p>' +
    '<w:tbl><w:tr>' +
    '<w:tc><w:p><w:r><w:t>X</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>Y</w:t></w:r></w:p></w:tc>' +
    '<w:tc><w:p><w:r><w:t>Z</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>'
  return shell(body)
}

async function docxWithMultiParaCell(): Promise<Uint8Array> {
  const body =
    '<w:tbl><w:tr>' +
    '<w:tc>' +
    '<w:p><w:r><w:t>First paragraph of cell.</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second paragraph of cell.</w:t></w:r></w:p>' +
    '</w:tc>' +
    '<w:tc><w:p><w:r><w:t>Right cell</w:t></w:r></w:p></w:tc>' +
    '</w:tr></w:tbl>'
  return shell(body)
}

describe('extractDocxTables', () => {
  it('returns an empty array when the document has no tables', async () => {
    const body =
      '<w:p><w:r><w:t>Heading paragraph</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>Body paragraph with no table.</w:t></w:r></w:p>'
    const bytes = await shell(body)
    const tables = await extractDocxTables(bytes)
    expect(tables).toEqual([])
  })

  it('extracts every top-level table in document order', async () => {
    const bytes = await docxWithTwoTables()
    const tables = await extractDocxTables(bytes)
    expect(tables).toHaveLength(2)
    expect(tables[0].rows).toEqual([
      ['A1', 'B1'],
      ['A2', 'B2'],
    ])
    expect(tables[1].rows).toEqual([['X', 'Y', 'Z']])
    expect(tables[0].blockId).toBeTruthy()
    expect(tables[1].blockId).toBeTruthy()
  })

  it('joins multi-paragraph cells with a single newline', async () => {
    const bytes = await docxWithMultiParaCell()
    const [table] = await extractDocxTables(bytes)
    expect(table.rows).toEqual([
      ['First paragraph of cell.\nSecond paragraph of cell.', 'Right cell'],
    ])
  })

  it('throws on non-docx bytes', async () => {
    const buffer = Buffer.from('not a docx file at all')
    await expect(extractDocxTables(new Uint8Array(buffer))).rejects.toThrow()
  })
})

describe('extractDocxImages', () => {
  it('returns an empty array when the document has no images', async () => {
    const body = '<w:p><w:r><w:t>No images here.</w:t></w:r></w:p>'
    const path = writeFixture('no-images.docx', await shell(body))
    const bytes = new Uint8Array(await import('node:fs').then((fs) =>
      fs.promises.readFile(path),
    ))
    const images = await extractDocxImages(bytes)
    expect(images).toEqual([])
  })

  it('extracts every inline body image as a data URL', async () => {
    // The image fixture is built by stringifying w:drawing directly into
    // the body so we can keep this test purely in TypeScript without
    // spinning up a full docx fixture helper.
    const body =
      `<w:p><w:r><w:t>before image</w:t></w:r></w:p>` +
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
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    const images = await extractDocxImages(bytes)
    expect(images.length).toBe(1)
    expect(images[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    // 2 inches at 914400 EMU per inch = 1828800 EMU = 192 CSS px at 9525 ratio.
    expect(images[0].widthPx).toBe(192)
    expect(images[0].heightPx).toBe(192)
  })

  it('throws on non-docx bytes', async () => {
    const buffer = Buffer.from('this is plain text')
    await expect(extractDocxImages(new Uint8Array(buffer))).rejects.toThrow()
  })
})
