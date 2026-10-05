/**
 * Drive-embed save contract for the pdf renderer.
 *
 * The cloud-drive embed replaces `window.pdfApi.save` with an override that
 * (a) lets the server write the managed temp copy and (b) then pushes the
 * resulting bytes to the host as a new revision. Two properties of that
 * override are load-bearing and had no coverage:
 *
 *  1. It must never reject. `SavePdfResult` is the whole contract every caller
 *     understands — App.tsx renders `!result.ok` as a toast and has no
 *     try/catch around the call. `pdfApi.save` is a bare pass-through to the
 *     transport (`createPdfApi`), and the HTTP transport *throws*
 *     `IpcBridgeError` on any network failure or non-200. So a server fault
 *     used to reject the promise: no toast, no host notification, and the
 *     drive revision silently never moved.
 *
 *  2. When the host push fails, the failure must surface as `{ ok: false }`
 *     rather than a success the UI would render as "saved".
 *
 * These run the real `web-bridge.ts` (its whole install is gated on
 * `!isElectronRuntime()`, true under jsdom) and stub `fetch`, so the transport
 * really does reject rather than the test re-implementing the override.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { SavePdfResult } from '../src/shared/ipc'

const PDF_SAVE_CHANNEL = 'pdf:save'

/** Shape the transport posts for an IPC invoke, so the stub can tell saves
 *  apart from the other channels the install fires during module load. The
 *  channel is percent-encoded into the URL (`pdf%3Asave`). */
function isPdfSave(url: unknown): boolean {
  return typeof url === 'string' && decodeURIComponent(url).includes('/pdf:save')
}

describe('pdf drive-embed save override', () => {
  let fetchStub: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()
    delete (window as unknown as Record<string, unknown>).pdfApi
    fetchStub = vi.fn()
    vi.stubGlobal('fetch', fetchStub)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function installBridge(): Promise<void> {
    await import('../src/renderer/web-bridge')
  }

  it('folds a transport rejection into { ok: false } instead of rejecting', async () => {
    // Server unreachable / 500: the HTTP transport throws IpcBridgeError.
    fetchStub.mockRejectedValue(new TypeError('Failed to fetch'))
    await installBridge()

    const save = (window as unknown as { pdfApi: { save: (r: unknown) => Promise<SavePdfResult> } })
      .pdfApi.save
    const result = await save({ path: '/tmp/genoffice-web-temp/x.pdf' })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('Failed to fetch')
  })

  it('surfaces a non-200 IPC response as { ok: false }', async () => {
    // A structured IPC error body: the transport throws rather than resolving,
    // so this must not escape as a rejection either.
    fetchStub.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'boom', code: 'INTERNAL' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await installBridge()

    const save = (window as unknown as { pdfApi: { save: (r: unknown) => Promise<SavePdfResult> } })
      .pdfApi.save
    const result = await save({ path: '/tmp/genoffice-web-temp/x.pdf' })

    expect(result.ok).toBe(false)
  })

  it('passes a server-reported save failure straight through', async () => {
    // The web-server's pdf:save catch returns { ok:false, error } with HTTP 200.
    // The override must not mask it as a success and must not re-wrap it.
    fetchStub.mockImplementation(async (url: unknown) => {
      if (isPdfSave(url)) {
        return new Response(
          JSON.stringify({ ok: true, result: { ok: false, error: 'source not found' } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ ok: true, result: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    await installBridge()

    const save = (window as unknown as { pdfApi: { save: (r: unknown) => Promise<SavePdfResult> } })
      .pdfApi.save
    const result = await save({ path: '/tmp/genoffice-web-temp/x.pdf' })

    expect(result).toEqual({ ok: false, error: 'source not found' })
  })
})
