/**
 * PDF → editable DOCX fallback.
 *
 * The module is dependency-injected precisely so the ordering guarantees are
 * testable without a document, a server, or a drive — and those guarantees are
 * the whole risk of the feature:
 *
 *   - nothing is converted without a source;
 *   - nothing is filed when the conversion failed;
 *   - a converter that claims success but returns no bytes produces **no
 *     file**, because a zero-byte `.docx` in the user's drive is precisely the
 *     failure this path exists to avoid;
 *   - a scanned document is flagged rather than presented as editable text.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  DOCX_CONTENT_TYPE,
  createEditableDocx,
  deriveEditableDocxName,
  type CreateEditableDocxDeps,
} from '../src/renderer/ai/editable-docx'
// Declared next to the channel it belongs to; re-asserted here so a change to
// the wire contract fails the behaviour tests too, not just the type checker.
import type { PdfToDocxResponse } from '../src/shared/ipc'

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00])

function deps(overrides: Partial<CreateEditableDocxDeps> = {}) {
  const convert = vi.fn(async (): Promise<PdfToDocxResponse> => ({
    ok: true,
    docx: DOCX_BYTES,
    pages: 3,
  }))
  const saveAsDocx = vi.fn(async () => ({ ok: true, itemId: '77' }))
  const readSource = vi.fn(async () => PDF_BYTES.buffer as ArrayBuffer)
  return {
    readSource,
    convert,
    saveAsDocx,
    sourceName: '手册.pdf',
    ...overrides,
  }
}

describe('deriveEditableDocxName', () => {
  it('replaces the extension — the whole point is that the format changed', () => {
    expect(deriveEditableDocxName('手册.pdf')).toBe('手册.editable.docx')
  })

  it('appends when there is no extension', () => {
    expect(deriveEditableDocxName('report')).toBe('report.editable.docx')
  })

  it('does not treat a leading dot as an extension', () => {
    expect(deriveEditableDocxName('.gitignore')).toBe('.gitignore.editable.docx')
  })

  it('treats a trailing dot as part of the base name', () => {
    expect(deriveEditableDocxName('weird.')).toBe('weird..editable.docx')
  })

  it('falls back to a placeholder for a blank name', () => {
    expect(deriveEditableDocxName('   ')).toBe('untitled.editable.docx')
    expect(deriveEditableDocxName(null)).toBe('untitled.editable.docx')
  })

  it('truncates the base, never the .editable.docx tail', () => {
    const long = `${'x'.repeat(400)}.pdf`
    const name = deriveEditableDocxName(long)
    expect(name.endsWith('.editable.docx')).toBe(true)
    expect(name.length).toBeLessThanOrEqual(255)
  })
})

describe('createEditableDocx', () => {
  it('converts and files the result next to the source', async () => {
    const d = deps()
    const out = await createEditableDocx(d)

    expect(out).toMatchObject({
      ok: true,
      fileName: '手册.editable.docx',
      itemId: '77',
      pages: 3,
      scannedDocument: false,
    })
    expect(d.saveAsDocx).toHaveBeenCalledTimes(1)
    expect(d.saveAsDocx.mock.calls[0]?.[1]).toBe('手册.editable.docx')
  })

  it('hands the upload exactly the converted bytes', async () => {
    const d = deps()
    await createEditableDocx(d)
    const payload = d.saveAsDocx.mock.calls[0]?.[0] as ArrayBuffer
    expect(new Uint8Array(payload)).toEqual(DOCX_BYTES)
  })

  it('copies a view out of a larger buffer rather than uploading the whole pool', async () => {
    // The IPC codec decodes `{__ipcBytes:'u8', b64}` into a Uint8Array that may
    // sit inside a bigger backing store; uploading `.buffer` wholesale would
    // ship the surrounding bytes too.
    const pool = new Uint8Array(64)
    pool.set(DOCX_BYTES, 8)
    const d = deps({ convert: vi.fn(async () => ({ ok: true, docx: pool.subarray(8, 13) })) })

    await createEditableDocx(d)
    const payload = new Uint8Array(d.saveAsDocx.mock.calls[0]?.[0] as ArrayBuffer)
    expect(payload.byteLength).toBe(DOCX_BYTES.byteLength)
    expect(payload).toEqual(DOCX_BYTES)
  })

  it('does not convert when there is no source', async () => {
    const d = deps({ readSource: vi.fn(async () => null) })
    const out = await createEditableDocx(d)
    expect(out).toMatchObject({ ok: false, reason: 'no-source' })
    expect(d.convert).not.toHaveBeenCalled()
    expect(d.saveAsDocx).not.toHaveBeenCalled()
  })

  it('does not convert an empty source', async () => {
    const d = deps({ readSource: vi.fn(async () => new ArrayBuffer(0)) })
    expect(await createEditableDocx(d)).toMatchObject({ ok: false, reason: 'no-source' })
    expect(d.convert).not.toHaveBeenCalled()
  })

  it('reports an encrypted PDF as a password prompt, not a broken conversion', async () => {
    const d = deps({
      convert: vi.fn(async () => ({ ok: false, code: 'PDF_PASSWORD_REQUIRED', message: 'locked' })),
    })
    const out = await createEditableDocx(d)
    expect(out).toMatchObject({ ok: false, reason: 'password-required', message: 'locked' })
    expect(d.saveAsDocx).not.toHaveBeenCalled()
  })

  it('reports every other converter failure as a conversion failure', async () => {
    const d = deps({
      convert: vi.fn(async () => ({ ok: false, code: 'CONVERT_FAILED', message: 'boom' })),
    })
    expect(await createEditableDocx(d)).toMatchObject({
      ok: false,
      reason: 'convert-failed',
      message: 'boom',
    })
    expect(d.saveAsDocx).not.toHaveBeenCalled()
  })

  it('files nothing when the converter claims success but returns no bytes', async () => {
    const d = deps({ convert: vi.fn(async () => ({ ok: true, docx: new Uint8Array(0) })) })
    expect(await createEditableDocx(d)).toMatchObject({ ok: false, reason: 'empty-output' })
    expect(d.saveAsDocx).not.toHaveBeenCalled()
  })

  it('files nothing when the converter claims success and omits the bytes', async () => {
    const d = deps({ convert: vi.fn(async () => ({ ok: true })) })
    expect(await createEditableDocx(d)).toMatchObject({ ok: false, reason: 'empty-output' })
    expect(d.saveAsDocx).not.toHaveBeenCalled()
  })

  it('surfaces an upload refusal as a save failure, not a conversion failure', async () => {
    const d = deps({ saveAsDocx: vi.fn(async () => ({ ok: false, error: 'quota exceeded' })) })
    expect(await createEditableDocx(d)).toMatchObject({
      ok: false,
      reason: 'save-failed',
      message: 'quota exceeded',
    })
  })

  it('flags a scanned document — the DOCX holds page images, not editable text', async () => {
    const d = deps({
      convert: vi.fn(async () => ({
        ok: true,
        docx: DOCX_BYTES,
        pages: 12,
        scannedDocument: true,
        warnings: ['page 3 has no text layer'],
      })),
    })
    const out = await createEditableDocx(d)
    expect(out).toMatchObject({ ok: true, scannedDocument: true, pages: 12 })
    expect(out).toMatchObject({ warnings: ['page 3 has no text layer'] })
  })

  it('exports the Word MIME so the host files it as a document, not as a PDF', () => {
    expect(DOCX_CONTENT_TYPE).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })
})
