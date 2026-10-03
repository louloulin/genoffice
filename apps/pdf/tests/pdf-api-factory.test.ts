/**
 * `pdfToDocx` on the pdf API surface.
 *
 * The interesting part is not the happy path but the two ways it can go wrong
 * in ways that would otherwise be invisible:
 *
 *   1. it must address the **web-server** anydoc channel, not one of the shell
 *      channels — the desktop shell only registers the AI handlers, so a typo
 *      here produces a channel that exists in no build at all;
 *   2. in the desktop build that channel is genuinely absent, so `invoke`
 *      rejects. A missing optional capability has to arrive as `ok: false` in
 *      the channel's own vocabulary, not as a rejected promise the caller
 *      forgets to handle.
 */
import { describe, expect, it, vi } from 'vitest'

import { createPdfApi } from '../src/shared/pdf-api-factory'
import { ANYDOC_CHANNELS } from '../src/shared/ipc'
import type { IpcTransport } from '@genoffice/ipc-bridge/client'

function makeTransport(invoke: IpcTransport['invoke']): IpcTransport {
  return { invoke, send: vi.fn(), on: vi.fn(() => () => {}) } as unknown as IpcTransport
}

describe('pdfApi.pdfToDocx', () => {
  it('addresses the web-server anydoc channel', async () => {
    const invoke = vi.fn(async () => ({ ok: true, docx: new Uint8Array([1]), pages: 1 }))
    const api = createPdfApi(makeTransport(invoke))

    await api.pdfToDocx(new Uint8Array([0x25, 0x50]).buffer)

    expect(invoke).toHaveBeenCalledTimes(1)
    // Not `ai:*` and not `pdf:*`: anydoc is registered by the web-server.
    expect(invoke.mock.calls[0]?.[0]).toBe(ANYDOC_CHANNELS.pdfToDocxBytes)
    expect(invoke.mock.calls[0]?.[0]).toBe('anydoc:pdf-to-docx-bytes')
  })

  it('passes the bytes through for the transport codec to tag', async () => {
    const invoke = vi.fn(async () => ({ ok: true, docx: new Uint8Array([1]) }))
    const api = createPdfApi(makeTransport(invoke))
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer

    await api.pdfToDocx(pdf)

    const arg = invoke.mock.calls[0]?.[1] as { pdf: ArrayBuffer }
    expect(arg.pdf).toBe(pdf)
  })

  it('returns the handler result untouched on success', async () => {
    const docx = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    const invoke = vi.fn(async () => ({ ok: true, docx, pages: 4, scannedDocument: true }))
    const api = createPdfApi(makeTransport(invoke))

    const out = await api.pdfToDocx(new ArrayBuffer(1))

    expect(out).toMatchObject({ ok: true, pages: 4, scannedDocument: true })
    // Untouched matters: the caller checks `scannedDocument` to decide what to
    // tell the user, and a transport that dropped it would silently understate
    // what they are about to open.
    expect(out.docx).toBe(docx)
  })

  it('reports a missing handler (desktop build) as a plain failure, not a rejection', async () => {
    const invoke = vi.fn(async () => {
      throw new Error("No IPC handler for 'anydoc:pdf-to-docx-bytes'")
    })
    const api = createPdfApi(makeTransport(invoke))

    const out = await api.pdfToDocx(new ArrayBuffer(1))

    expect(out.ok).toBe(false)
    expect(out.code).toBe('CONVERT_FAILED')
    expect(out.message).toContain('anydoc:pdf-to-docx-bytes')
  })
})
