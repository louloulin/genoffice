/**
 * `anydoc:pdf-to-docx-bytes` — the transport-shaped door onto the PDF → DOCX
 * converter for callers that hold bytes instead of a server-side path.
 *
 * The Dataflare drive is what needs this: a document's bytes live in
 * Dataflare's object storage and reach the editor as an ArrayBuffer, so the
 * path-based `anydoc:convert` (which reads and writes inside the server's own
 * FILES_DIR) cannot serve it without staging the user's document onto a disk
 * that is not the store of record.
 *
 * Most of what matters here is what the handler must NOT do, and a conversion
 * that silently produced something unusable is worse than one that refused:
 *
 *   1. it never touches the filesystem — the result is bytes, not a path;
 *   2. an empty/absent input is reported as a *caller* mistake, distinct from a
 *      conversion failure, so the UI can say "nothing was sent" instead of
 *      "conversion failed";
 *   3. garbage in does not become a fabricated DOCX out;
 *   4. a scanned document is flagged, because its DOCX carries page images
 *      rather than editable text — handing that over unlabelled is how
 *      "translated" ends up meaning "re-typeset the scan".
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getHandler } from '../src/common/registry'
import { _resetPdfiumForTests } from '../src/anydoc/convert'

type BytesOutcome =
  | {
      ok: true
      docx: Uint8Array
      pages: number
      warnings?: string[]
      scannedDocument?: boolean
    }
  | { ok: false; code: string; message?: string }

const CHANNEL = 'anydoc:pdf-to-docx-bytes'

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

async function invoke(args: unknown): Promise<BytesOutcome> {
  const handler = getHandler(CHANNEL)
  if (!handler) throw new Error(`${CHANNEL} is not registered`)
  return (await handler({} as never, args)) as BytesOutcome
}

describe('anydoc:pdf-to-docx-bytes', () => {
  beforeAll(async () => {
    const { registerAnydocHandlers } = await import('../src/anydoc/index')
    registerAnydocHandlers()
    _resetPdfiumForTests()
  })

  it('is registered', () => {
    expect(getHandler(CHANNEL)).toBeTypeOf('function')
  })

  it('converts real PDF bytes into a real DOCX container', async () => {
    const out = await invoke({ pdf: minimalPdf() })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // PK\x03\x04 is the local-file-header magic of a zip container; DOCX is one.
    expect(Array.from(out.docx.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(out.docx.byteLength).toBeGreaterThan(0)
    expect(out.pages).toBe(1)
  })

  it('returns bytes, never a filesystem path', async () => {
    const out = await invoke({ pdf: minimalPdf() })
    // A `path` here would invite a caller to persist the result on this
    // machine — the exact staging step this channel exists to avoid.
    expect(Object.keys(out as object)).not.toContain('path')
  })

  it('accepts a Uint8Array decoded from the IPC transport', async () => {
    // The wire form is `{__ipcBytes:'u8', b64}`; `decodeTransportValue` hands
    // the handler a real Uint8Array. Guard the shape the transport produces.
    const out = await invoke({ pdf: new Uint8Array(minimalPdf()) })
    expect(out.ok).toBe(true)
  })

  it('reports an empty payload as a caller mistake, not a conversion failure', async () => {
    const out = await invoke({ pdf: new Uint8Array(0) })
    expect(out.ok).toBe(false)
    if (out.ok) return
    // Distinct code on purpose: the UI says "nothing was sent", not
    // "this PDF could not be converted".
    expect(out.code).toBe('EMPTY_INPUT')
  })

  it('rejects a missing payload with the same caller-mistake code', async () => {
    const out = await invoke({})
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('EMPTY_INPUT')
  })

  it('does not fabricate a DOCX from bytes that are not a PDF', async () => {
    const out = await invoke({ pdf: Buffer.from('this is definitely not a pdf') })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).not.toBe('EMPTY_INPUT')
    expect((out as { docx?: unknown }).docx).toBeUndefined()
  })

  it('never writes to disk — the handler body holds no filesystem calls', () => {
    const source = readFileSync(join(__dirname, '..', 'src', 'anydoc', 'index.ts'), 'utf8')
    const start = source.indexOf(`registerHandle('${CHANNEL}'`)
    expect(start).toBeGreaterThanOrEqual(0)
    const open = source.indexOf('(', start)
    let depth = 0
    let body = ''
    for (let i = open; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) {
          body = source.slice(open, i + 1)
          break
        }
      }
    }
    expect(body).not.toBe('')
    for (const call of ['writeFileSync', 'atomicWriteFile', 'mkdirSync', 'requireManagedPath']) {
      expect(body).not.toContain(call)
    }
  })
})
