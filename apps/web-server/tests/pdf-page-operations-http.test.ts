/// Standalone HTTP coverage for the page-operations wave: extract, insert,
/// blank page, split, N-up merge, replace, resize, split-pages, crop and
/// multi-file merge. Every case builds a real multi-page PDF, drives the real
/// loopback server, and re-parses the returned bytes with pdf-lib, so a wrong
/// page count or a lost rotation fails here instead of in a browser.

import { PDFDocument, degrees } from 'pdf-lib'
import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { createWebComposition } from '../src/main.js'

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return {
    status: response.status,
    body: (await response.json()) as { result?: any; error?: { message?: string } },
  }
}

function decodeBytes(value: { __ipcBytes?: string; b64?: string }): Uint8Array {
  expect(value.__ipcBytes).toBe('u8')
  return new Uint8Array(Buffer.from(value.b64 ?? '', 'base64'))
}

/** A real PDF with `pages` differently sized pages; the last one is rotated 90. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let index = 0; index < pages; index += 1) {
    const page = doc.addPage([200 + index * 10, 300 + index * 10])
    if (index === pages - 1) page.setRotation(degrees(90))
  }
  return doc.save({ useObjectStreams: false })
}

async function pageCount(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes, { updateMetadata: false })).getPageCount()
}

async function withServer<T>(run: (port: number) => Promise<T>): Promise<T> {
  const app = await createWebComposition({ port: 0 })
  try {
    return await run(app.server.port)
  } finally {
    await app.server.close()
  }
}

describe('PDF page operations over standalone HTTP', () => {
  it('extracts a page subset and ignores out-of-range indices', async () => {
    const source = await makePdf(4)
    await withServer(async (port) => {
      const extracted = await call(port, 'pdf:extract-pages', [source, [0, 2, 99]])
      expect(extracted.status).toBe(200)
      expect(await pageCount(decodeBytes(extracted.body.result))).toBe(2)

      const bad = await call(port, 'pdf:extract-pages', [source, 'nope'])
      expect(bad.status).toBe(500)
      expect(bad.body.error?.message).toContain('array of page indices')
    })
  })

  it('inserts another document and a blank page', async () => {
    const source = await makePdf(3)
    const other = await makePdf(2)
    await withServer(async (port) => {
      const inserted = await call(port, 'pdf:insert-pdf', [source, other, 0])
      expect(inserted.status).toBe(200)
      expect(inserted.body.result.count).toBe(2)
      expect(await pageCount(decodeBytes(inserted.body.result.merged))).toBe(5)

      const blank = await call(port, 'pdf:insert-blank-page', [source, -1])
      const doc = await PDFDocument.load(decodeBytes(blank.body.result), { updateMetadata: false })
      expect(doc.getPageCount()).toBe(4)
      // The blank page copies its neighbour's size, so the first page stays 200 wide.
      expect(Math.round(doc.getPage(0).getWidth())).toBe(200)

      expect((await call(port, 'pdf:insert-blank-page', [source, 1.5])).status).toBe(500)
    })
  })

  it('splits into chunks and rejects a non-positive chunk size', async () => {
    const source = await makePdf(5)
    await withServer(async (port) => {
      const split = await call(port, 'pdf:split-pdf', [source, 2])
      expect(split.status).toBe(200)
      expect(split.body.result).toHaveLength(3)
      const counts = await Promise.all(
        split.body.result.map((part: { b64: string }) => pageCount(decodeBytes(part))),
      )
      expect(counts).toEqual([2, 2, 1])

      expect((await call(port, 'pdf:split-pdf', [source, 0])).status).toBe(500)
    })
  })

  it('imposes N-up sheets and splits them back apart', async () => {
    const source = await makePdf(4)
    await withServer(async (port) => {
      const merged = await call(port, 'pdf:merge-pages', [
        source,
        { perSheet: 2, direction: 'horizontal', separator: true },
      ])
      expect(merged.status).toBe(200)
      const sheets = await PDFDocument.load(decodeBytes(merged.body.result), {
        updateMetadata: false,
      })
      expect(sheets.getPageCount()).toBe(2)
      // 2-up swaps the first page's dimensions so two portrait pages sit side by side.
      expect(Math.round(sheets.getPage(0).getWidth())).toBe(300)

      const back = await call(port, 'pdf:split-pages', [source, 4])
      expect(await pageCount(decodeBytes(back.body.result))).toBe(16)

      expect((await call(port, 'pdf:split-pages', [source, 3])).status).toBe(500)
      expect((await call(port, 'pdf:merge-pages', [source, { perSheet: 'two' }])).status).toBe(500)
    })
  })

  it('replaces pages, resizes to A4 and crops', async () => {
    const source = await makePdf(4)
    const other = await makePdf(1)
    await withServer(async (port) => {
      const replaced = await call(port, 'pdf:replace-pages', [source, other, [1, 2]])
      expect(replaced.body.result.removed).toBe(2)
      expect(replaced.body.result.inserted).toBe(1)
      expect(await pageCount(decodeBytes(replaced.body.result.merged))).toBe(3)

      const resized = await call(port, 'pdf:set-page-size', [source, 595.28, 841.89])
      const doc = await PDFDocument.load(decodeBytes(resized.body.result), {
        updateMetadata: false,
      })
      expect(Math.round(doc.getPage(0).getWidth())).toBe(595)
      expect(Math.round(doc.getPage(0).getHeight())).toBe(842)
      // The rotated last page gets the swapped target so its displayed size matches.
      const last = doc.getPage(doc.getPageCount() - 1)
      expect(Math.round(last.getWidth())).toBe(842)

      const cropped = await call(port, 'pdf:crop-pages', [
        source,
        [0],
        { l: 0.25, t: 0.25, r: 0.75, b: 0.75 },
      ])
      const croppedDoc = await PDFDocument.load(decodeBytes(cropped.body.result), {
        updateMetadata: false,
      })
      expect(Math.round(croppedDoc.getPage(0).getCropBox().width)).toBe(100)

      expect((await call(port, 'pdf:set-page-size', [source, -1, 100])).status).toBe(500)
      expect((await call(port, 'pdf:crop-pages', [source, [0], { l: 0 }])).status).toBe(500)
    })
  })

  it('merges several documents into one', async () => {
    const first = await makePdf(2)
    const second = await makePdf(3)
    const third = await makePdf(1)
    await withServer(async (port) => {
      const merged = await call(port, 'pdf:merge-pdfs', [first, [second, third]])
      expect(merged.status).toBe(200)
      expect(merged.body.result.appended).toBe(4)
      expect(await pageCount(decodeBytes(merged.body.result.merged))).toBe(6)

      expect((await call(port, 'pdf:merge-pdfs', [first, 'nope'])).status).toBe(500)
    })
  })
})
