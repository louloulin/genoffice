/**
 * `anydoc:convert` — the PDF → DOCX half of the conversion matrix.
 *
 * This handler used to be a blanket WEB_UNSUPPORTED stub. The stub was
 * introduced to stop a worse bug (the old code wrote the *source* bytes to a
 * path with a `.docx` extension and returned `success: true`, so the renderer
 * opened a file no reader could parse), but it also meant a conversion the
 * server genuinely can perform was refused.
 *
 * PDF → DOCX needs no external process: `@genoffice/pdf2docx` is pure
 * TypeScript and only wants an initialized pdfium wasm, both of which ship in
 * this repo. These tests pin that down, and pin the *refusals* too — a
 * regression that fabricates an output file is worse than one that fails.
 *
 * The DOCX → PDF direction stays unsupported on purpose: it needs a layout
 * engine (the desktop build shells out to LibreOffice) that the web build does
 * not ship. There is no honest way to implement it here, so the test asserts
 * the refusal rather than pretending otherwise.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  _resetPdfiumForTests,
  convertPdfToDocxBytes,
  pdfiumPackageDir,
} from '../src/anydoc/convert'

/** A minimal single-page PDF with one line of real text. */
function minimalPdf(text = 'Hello GenOffice'): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

describe('convertPdfToDocxBytes', () => {
  beforeEach(() => {
    // Each case starts from a cold wasm module so the lazy-init path is
    // exercised rather than the cached module from a sibling test.
    _resetPdfiumForTests()
  })

  it('locates the pdfium wasm that ships inside the package dist/', () => {
    // Regression: the package export map is `./pdfium.wasm` →
    // `./dist/pdfium.wasm`, so a path built as `<pkg>/pdfium.wasm` resolves to
    // a file that does not exist.
    const dir = pdfiumPackageDir()
    expect(existsSync(join(dir, 'pdfium.wasm'))).toBe(true)
  })

  it('converts a text PDF into real DOCX bytes (PK zip container)', async () => {
    const out = await convertPdfToDocxBytes(minimalPdf())
    expect(out.ok).toBe(true)
    expect(out.docx).toBeInstanceOf(Uint8Array)
    expect(out.docx!.byteLength).toBeGreaterThan(0)
    // A DOCX is an OOXML zip; the magic is the only thing a reader checks
    // first, and a fabricated "copy of the PDF" would fail it.
    expect(Buffer.from(out.docx!.subarray(0, 2)).toString('latin1')).toBe('PK')
    expect(out.pages).toBe(1)
  })

  it('rejects a corrupt PDF with PDF_LOAD_FAILED instead of throwing', async () => {
    const out = await convertPdfToDocxBytes(Buffer.from('not a pdf at all'))
    expect(out.ok).toBe(false)
    expect(out.code).toBe('PDF_LOAD_FAILED')
    expect(out.docx).toBeUndefined()
  })

  it('never fabricates an output for an empty input', async () => {
    const out = await convertPdfToDocxBytes(new Uint8Array(0))
    expect(out.ok).toBe(false)
    expect(out.docx).toBeUndefined()
  })

  it('reuses the initialized wasm across calls', async () => {
    const first = await convertPdfToDocxBytes(minimalPdf('one'))
    const second = await convertPdfToDocxBytes(minimalPdf('two'))
    expect(first.ok && second.ok).toBe(true)
    expect(second.docx!.byteLength).toBeGreaterThan(0)
  })
})

describe('convertPdfToDocxBytes against real fixture PDFs', () => {
  beforeEach(() => _resetPdfiumForTests())

  const fixtures = join(__dirname, '..', '..', 'shell', 'tests', 'fixtures')

  it.skipIf(!existsSync(join(fixtures, 'testPassword4Spaces.pdf')))(
    'asks for a password when the PDF is encrypted',
    async () => {
      const out = await convertPdfToDocxBytes(readFileSync(join(fixtures, 'testPassword4Spaces.pdf')))
      expect(out.ok).toBe(false)
      // Must be distinguishable from a generic failure so the renderer prompts
      // for a password instead of showing "conversion failed".
      expect(out.code).toBe('PDF_PASSWORD_REQUIRED')
    },
  )

  it.skipIf(!existsSync(join(fixtures, 'corruptExample.pdf')))(
    'reports a corrupt fixture as unloadable',
    async () => {
      const out = await convertPdfToDocxBytes(readFileSync(join(fixtures, 'corruptExample.pdf')))
      expect(out.ok).toBe(false)
      expect(out.code).toBe('PDF_LOAD_FAILED')
    },
  )
})

describe('pdf → docx output hygiene', () => {
  it('writes nothing when the source cannot be converted', async () => {
    // The whole point of the P1 fix: a failed conversion must not leave a
    // mis-named file behind. We simulate the handler's contract here — the
    // helper returns `docx: undefined`, so a caller that only writes on
    // `ok === true` cannot produce a broken artifact.
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-convert-'))
    try {
      const target = join(dir, 'out.docx')
      const out = await convertPdfToDocxBytes(Buffer.from('%PDF-1.4\ntruncated'))
      expect(out.ok).toBe(false)
      if (out.ok && out.docx) writeFileSync(target, out.docx)
      expect(existsSync(target)).toBe(false)
      // And the directory really is writable, so the assertion above proves
      // the write was skipped and not merely rejected by the filesystem.
      writeFileSync(target, 'x')
      expect(statSync(target).size).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
