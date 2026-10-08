/**
 * PDF handlers (M4) — the pdf half of the DoD: a pdf opens through the host, a
 * page op and a save round-trip, and the saved bytes re-open with the change
 * intact. Shape mirrors `ui-slides.test.ts`.
 *
 * The fixture is built with pdf-lib rather than checked in, so the test owns
 * exactly the page count and metadata it asserts on and does not depend on a
 * binary blob nobody can regenerate.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'

import { startUiHost, type UiHostHandle } from '../src/ui/host'
import { registerPdfHandlers, STUBBED_PDF_CHANNELS } from '../src/ui/handlers/pdf'
import { decodeTransportValue } from '../src/ui/codec'
import { PDF_CHANNELS } from '../src/ui/handlers/pdf/engine/ipc-types'

const PDF_RENDERER_DIR = fileURLToPath(new URL('../../../apps/pdf/out/renderer', import.meta.url))
/** The pdf renderer is a build artifact; without it the static-asset assertions
 *  are skipped but every channel round-trip below still runs. */
const HAS_PDF_RENDERER = existsSync(join(PDF_RENDERER_DIR, 'index.html'))

let host: UiHostHandle | null = null

/**
 * The host under test. `registerPdfHandlers` is called on the context's own
 * registry rather than going through `createHostContext`, because wiring it into
 * `host.ts` is a separate change (see the diff in the PR description).
 */
async function bootHost(): Promise<UiHostHandle> {
  const root = mkdtempSync(join(tmpdir(), 'office-ai-pdf-'))
  if (HAS_PDF_RENDERER) symlinkSync(PDF_RENDERER_DIR, join(root, 'pdf'), 'dir')
  host = await startUiHost({ assetsDir: root })
  registerPdfHandlers(host.context.registry, host.context.workspace)
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function invoke(
  channel: string,
  args: unknown[] = [],
): Promise<{ status: number; body: { result?: any; error?: { code: string; message: string } } }> {
  const response = await fetch(`${host!.url}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': 'pdf-session' },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

/** Three A4 pages with real text, so text extraction and page ops have work to do. */
async function makeFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595.28, 841.89])
    page.drawText(`page ${i} of the fixture`, {
      x: 72,
      y: 760,
      size: 24,
      font,
    })
  }
  return doc.save()
}

/** Stage a fixture and open it the way the renderer's boot sequence does. */
async function openFixture(): Promise<string> {
  const staged = host!.open('pdf', await makeFixture(), { name: 'fixture.pdf' })
  const opened = await invoke('pdf:open-path', [staged.path])
  expect(opened.status).toBe(200)
  expect(opened.body.result.path).toBe(staged.path)
  return staged.path
}

/**
 * Minimal reader for the PNGs `rgbaToPng` writes (colour type 6, filter none),
 * so the preview assertion can look at an actual pixel rather than only the file
 * being non-empty. A decoder is deliberately not a dependency of this package —
 * this is test-only, and it reads exactly the shape `src/ui/png.ts` emits.
 */
function decodePng(png: Buffer): { width: number; height: number; rgba: Uint8Array } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  const idat: Buffer[] = []
  let offset = 8
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0) // filter: none
    rgba.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride)
  }
  return { width, height, rgba }
}

describe('pdf handlers (M4)', () => {
  it('serves the pdf renderer bundle as a page', async () => {
    await bootHost()
    if (!HAS_PDF_RENDERER) {
      console.warn(`skipping static-asset assertions: no renderer bundle at ${PDF_RENDERER_DIR}`)
      return
    }
    const page = await fetch(`${host!.url}/pdf`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('opens a pdf and hands back bytes the renderer can rasterize', async () => {
    await bootHost()
    const path = await openFixture()
    const opened = (await invoke('pdf:open-path', [path])).body.result as {
      path: string
      bytes: unknown
    }
    // Over raw JSON the binary arrives tagged-base64; the renderer's transport
    // (@genoffice/ipc-bridge) decodes it with this exact codec, so decode it the
    // same way rather than asserting on the wire form.
    const buffer = decodeTransportValue(opened.bytes) as ArrayBuffer
    expect(buffer.byteLength).toBeGreaterThan(1000)
    // %PDF- is the header a renderer checks before handing the buffer to pdf.js.
    expect(Buffer.from(buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  it('rejects a path outside the workspace', async () => {
    await bootHost()
    const outside = await invoke('pdf:open-path', ['/etc/hosts'])
    expect(outside.status).toBe(400)
    expect(outside.body.error?.code).toBe('OFFICE_BAD_INPUT')

    const save = await invoke('pdf:save', [{ path: '/etc/hosts', markups: [], drawings: [], formValues: [], stamps: [] }])
    expect(save.status).toBe(200)
    expect(save.body.result.ok).toBe(false)
    expect(save.body.result.error).toContain('outside the office-ai workspace')
  })

  it('runs a page op then a save, and the saved bytes re-open with both changes', async () => {
    await bootHost()
    const path = await openFixture()

    // ── page op: insert a blank page after the first one, in place ─────────
    const inserted = await invoke('pdf:insert-blank-page', [{ path, afterPageIndex: 0 }])
    expect(inserted.status).toBe(200)
    expect(inserted.body.result).toEqual({ ok: true })

    // ── save: rewrite the document title ──────────────────────────────────
    const saved = await invoke('pdf:save', [
      {
        path,
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
        metadata: { title: 'OFFICE-AI-WAS-HERE' },
      },
    ])
    expect(saved.status).toBe(200)
    expect(saved.body.result.ok).toBe(true)
    // No edit was skipped; the skip channels must be absent, not empty arrays.
    expect(saved.body.result.skippedTextEdits).toBeUndefined()
    expect(saved.body.result.skippedImageEdits).toBeUndefined()

    // ── re-open the saved bytes under a brand-new path ────────────────────
    const copy = host!.context.workspace.stageBytes('reopened.pdf', host!.readFile(path))
    const reopened = await invoke('pdf:open-path', [copy])
    expect(reopened.status).toBe(200)
    expect((reopened.body.result as { path: string }).path).toBe(copy)

    // Read the bytes back with an independent parser, not the handler that wrote them.
    const doc = await PDFDocument.load(Buffer.from(host!.readFile(copy)))
    expect(doc.getPageCount()).toBe(4)
    expect(doc.getTitle()).toBe('OFFICE-AI-WAS-HERE')
  })

  it('leaves the source file untouched when pdf:save names a different target', async () => {
    await bootHost()
    const path = await openFixture()
    const before = Buffer.from(host!.readFile(path))

    const target = host!.context.workspace.stageBytes(
      'save-as.pdf',
      // stageBytes insists on new bytes; overwrite with a copy so the target exists
      before,
    )
    const saved = await invoke('pdf:save', [
      {
        path,
        targetPath: target,
        markups: [],
        drawings: [],
        formValues: [],
        stamps: [],
        metadata: { author: 'office-ai' },
      },
    ])
    expect(saved.body.result.ok).toBe(true)
    expect(Buffer.from(host!.readFile(path)).equals(before)).toBe(true)

    const written = await PDFDocument.load(Buffer.from(host!.readFile(target)))
    expect(written.getAuthor()).toBe('office-ai')
  })

  it('answers the four file-picker ops with their own canceled arm', async () => {
    await bootHost()
    for (const channel of [
      'pdf:insert-pdf',
      'pdf:merge-pdf',
      'pdf:replace-pages',
      'pdf:export-images',
    ]) {
      const res = await invoke(channel, [{ path: '/whatever.pdf' }])
      expect(res.status, channel).toBe(200)
      // Not `{ok:false}`: the renderer renders that as an error toast. There is
      // no dialog in a library host, so "canceled" is the truth.
      expect(res.body.result, channel).toEqual({ ok: true, canceled: true })
    }
  })

  it('generates sibling documents into the workspace exports dir', async () => {
    await bootHost()
    const path = await openFixture()

    const extracted = await invoke('pdf:extract-pages', [
      { path, pages: [0, 2], suggestedName: 'picked.pdf' },
    ])
    expect(extracted.body.result.ok).toBe(true)
    const savedPath = extracted.body.result.savedPath as string
    expect(savedPath.startsWith(host!.context.workspace.root)).toBe(true)
    expect((await PDFDocument.load(Buffer.from(host!.readFile(savedPath)))).getPageCount()).toBe(2)

    const split = await invoke('pdf:split-pdf', [{ path, chunkSize: 2, baseName: 'chunks' }])
    expect(split.body.result.ok).toBe(true)
    expect(split.body.result.count).toBe(2)

    const merged = await invoke('pdf:merge-pages', [
      { path, perSheet: 2, direction: 'horizontal', separator: true, suggestedName: 'nup.pdf' },
    ])
    expect(merged.body.result.ok).toBe(true)
    expect(
      (await PDFDocument.load(Buffer.from(host!.readFile(merged.body.result.savedPath)))).getPageCount(),
    ).toBe(2)
  })

  it('pushes dirtyChanged and saved so an embed SDK can track state', async () => {
    await bootHost()
    const path = await openFixture()

    const seen: Array<{ channel: string; args: any[] }> = []
    const controller = new AbortController()
    const response = await fetch(`${host!.url}/api/ipc/events?session=pdf-session`, {
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          for (const frame of buffer.split('\n\n')) {
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = JSON.parse(line.slice(5)) as { channel: string; args: unknown[] }
              seen.push(payload)
            }
          }
          buffer = ''
        }
      } catch {
        /* aborted */
      }
    })()

    await invoke('pdf:dirty-changed', [true])
    await invoke('pdf:save', [
      { path, markups: [], drawings: [], formValues: [], stamps: [], metadata: { subject: 's' } },
    ])
    await invoke('pdf:dirty-changed', [false])
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await pump

    const channels = seen.map((e) => e.channel)
    expect(channels).toContain('dirtyChanged')
    expect(channels).toContain('saved')
    expect(seen.find((e) => e.channel === 'dirtyChanged')!.args[0]).toEqual({ dirty: true })
    // The SDK reads `version` as its conflict watermark and `format` to scope it.
    const savedPayload = seen.find((e) => e.channel === 'saved')!.args[0] as {
      path: string
      version: number
      format: string
    }
    expect(savedPayload.format).toBe('pdf')
    expect(typeof savedPayload.version).toBe('number')
  })

  it('renders a page preview PNG with correct channel order', async () => {
    await bootHost()
    /* This is the guard for the one silent-corruption adaptation in the port.
     * pdfium hands back BGRA; Electron's nativeImage used to do the swap inside
     * toPNG(), and the library's rgbaToPng does not. A red rect is the fixture
     * that makes a missing swizzle visible — swapping R and B turns pure red
     * into pure blue and no error is raised anywhere. */
    const doc = await PDFDocument.create()
    const page = doc.addPage([100, 100])
    page.drawRectangle({ x: 0, y: 0, width: 100, height: 100, color: rgb(1, 0, 0) })
    const staged = host!.open('pdf', await doc.save(), { name: 'red.pdf' })

    const preview = await invoke('pdf:page-preview-png', [
      {
        path: staged.path,
        pageIndex: 0,
        excludeRects: [],
        clip: { x: 0, y: 0, width: 100, height: 100 },
        pxWidth: 8,
        rotate: 0,
      },
    ])
    expect(preview.status).toBe(200)
    const b64 = preview.body.result as string
    expect(typeof b64).toBe('string')

    const { width, height, rgba } = decodePng(Buffer.from(b64, 'base64'))
    expect(width).toBe(8)
    expect(height).toBe(8)
    const [r, g, b] = [rgba[0]!, rgba[1]!, rgba[2]!]
    expect([r, g, b]).toEqual([255, 0, 0])
  })

  it('acknowledges every documented stub channel instead of 404-ing', async () => {
    await bootHost()
    for (const [channel, value] of Object.entries(STUBBED_PDF_CHANNELS)) {
      const res = await invoke(channel, [])
      expect(res.status, channel).toBe(200)
      expect(res.body.result, channel).toEqual(value)
    }
  })

  it('registers every channel the pdf renderer can invoke', async () => {
    await bootHost()
    const body = (await (await fetch(`${host!.url}/api/channels`)).json()) as { channels: string[] }
    const registered = new Set(body.channels)
    // Every name in the shared PDF_CHANNELS map, so a channel added on the
    // desktop without a host counterpart fails here rather than at runtime.
    for (const name of Object.values(PDF_CHANNELS)) {
      if (name.startsWith('app:')) continue // app:* is registered globally by app-channels.ts
      expect(registered.has(name), name).toBe(true)
    }
    for (const name of ['pdf-password:get-state', 'pdf-password:submit', 'pdf-password:cancel']) {
      expect(registered.has(name), name).toBe(true)
    }
  })
})