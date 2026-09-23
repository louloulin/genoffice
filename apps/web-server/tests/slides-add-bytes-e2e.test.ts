/**
 * slides:add-image-bytes + slides:add-media-bytes — bridge contract fix
 * (sdk1 §11.91).
 *
 * Both channels used to read `o.bytes` while the bridge sends `base64`
 * (matching the AddImageBytesOp / AddMediaBytesOp contract and the
 * desktop main handler). The mismatch dereferenced undefined, so the
 * pptx-ops executor's `reqBytes` always threw and the channels answered
 * `null` — every web image/media insert silently failed.
 *
 * The fix forwards `o.base64` and validates the field up front. This
 * suite drives the bridge contract end-to-end: send the exact shape the
 * renderer emits, assert a non-null `{ slide, sourceId }` comes back,
 * save + reopen and confirm the bytes embedded into the archive.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'
import { openPptx } from '@genoffice/pptx-engine'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const blankTemplate = join(pkgRoot, 'src', 'shell', 'templates', 'blank.pptx')
const skip = !existsSync(bundle) || !existsSync(blankTemplate)

// Minimal PNG signature (8 bytes) — the executor doesn't decode image
// bytes, it just stores them; the test only checks the round-trip.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
])

async function pollHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('web-server did not become healthy')
}

describe.skipIf(skip)('slides:add-image-bytes + slides:add-media-bytes bridge contract (sdk1 §11.91)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let deck: string

  const invokeAs = async (session: string, channel: string, args: unknown[]) => {
    const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ipc-session': session },
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  const invoke = (channel: string, args: unknown[]) => invokeAs('add-bytes-e2e', channel, args)
  const unwrap = <T = Record<string, unknown>>(body: unknown): T | undefined =>
    (body as { result?: T })?.result

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-add-bytes-'))
    process.env.GENOFFICE_DATA_DIR = dataDir
    process.env.DATA_DIR = dataDir
    mkdirSync(join(dataDir, 'files'), { recursive: true })

    const port = 36500 + Math.floor(Math.random() * 1000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 20_000)

    deck = join(dataDir, 'files', 'add-bytes-deck.pptx')
    copyFileSync(blankTemplate, deck)
    const open = await invoke('slides:open-path', [deck, 1280])
    expect(open.status).toBe(200)
  }, 30_000)

  afterAll(async () => {
    await stopServer(server)
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  // ── Bridge-shape inputs (the actual shape web-bridge.ts sends) ──────────

  it('add-image-bytes accepts the bridge shape (base64 + px-coords) and persists', async () => {
    const r = await invoke('slides:add-image-bytes', [{
      slideIndex: 0,
      base64: TINY_PNG.toString('base64'),
      ext: 'png',
      xPx: 200,
      yPx: 150,
      wPx: 320,
      hPx: 240,
      fitWidthPx: 1280,
      name: 'tiny.png',
    }])
    expect(r.status).toBe(200)
    const result = unwrap<{ slide: unknown; sourceId: string }>(r.body)
    // The pre-fix answer was null (reqBytes threw). Post-fix must be a
    // committed {slide, sourceId} pair — the bridge sends base64, the
    // handler reads base64, the executor embeds, commitCreated returns.
    expect(result).toBeTruthy()
    expect(result!.sourceId).toBeTruthy()

    // Round-trip: save the live model, reopen, verify the image bytes
    // landed in the archive at the expected media path. The executor
    // writes PNGs to ppt/media/imageN.<ext> — we walk the archive and
    // confirm at least one entry matches the source bytes.
    const save = await invoke('slides:save', [undefined, deck, undefined])
    expect(save.status).toBe(200)
    expect(unwrap<{ ok: boolean }>(save.body)?.ok).toBe(true)

    const fresh = await openPptx(readFileSync(deck))
    const mediaEntries = [...fresh.archive.entries.keys()].filter((p) =>
      p.startsWith('ppt/media/'))
    expect(mediaEntries.length).toBeGreaterThan(0)
    const allBytes = mediaEntries
      .map((p) => fresh.archive.readBytes(p))
      .filter((b): b is Uint8Array => b != null)
    const match = allBytes.some((b) => Buffer.from(b).equals(TINY_PNG))
    expect(match).toBe(true)
  })

  it('add-media-bytes accepts the bridge shape and persists video bytes', async () => {
    const SAMPLE_MP4 = Buffer.from([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
      0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ])
    const r = await invoke('slides:add-media-bytes', [{
      slideIndex: 0,
      kind: 'video',
      base64: SAMPLE_MP4.toString('base64'),
      ext: 'mp4',
      fitWidthPx: 1280,
      name: 'clip.mp4',
    }])
    expect(r.status).toBe(200)
    const result = unwrap<{ slide: unknown; sourceId: string }>(r.body)
    expect(result).toBeTruthy()
    expect(result!.sourceId).toBeTruthy()

    const save = await invoke('slides:save', [undefined, deck, undefined])
    expect(save.status).toBe(200)

    const fresh = await openPptx(readFileSync(deck))
    const mediaEntries = [...fresh.archive.entries.keys()].filter((p) =>
      p.startsWith('ppt/media/'))
    expect(mediaEntries.length).toBeGreaterThan(0)
    const allBytes = mediaEntries
      .map((p) => fresh.archive.readBytes(p))
      .filter((b): b is Uint8Array => b != null)
    const match = allBytes.some((b) => Buffer.from(b).equals(SAMPLE_MP4))
    expect(match).toBe(true)
  })

  // ── Validation: missing / wrong-type base64 should answer null, not crash

  it('add-image-bytes answers null when base64 is missing', async () => {
    const r = await invoke('slides:add-image-bytes', [{
      slideIndex: 0,
      ext: 'png',
      xPx: 0, yPx: 0, wPx: 100, hPx: 100, fitWidthPx: 1280,
    }])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()
  })

  it('add-image-bytes answers null when base64 is empty', async () => {
    const r = await invoke('slides:add-image-bytes', [{
      slideIndex: 0,
      base64: '',
      ext: 'png',
      xPx: 0, yPx: 0, wPx: 100, hPx: 100, fitWidthPx: 1280,
    }])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()
  })

  it('add-media-bytes answers null when kind is missing', async () => {
    const r = await invoke('slides:add-media-bytes', [{
      slideIndex: 0,
      base64: 'aGVsbG8=',
      ext: 'mp4',
      name: 'x.mp4',
    }])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()
  })

  it('add-media-bytes answers null when kind is garbage', async () => {
    const r = await invoke('slides:add-media-bytes', [{
      slideIndex: 0,
      kind: 'image' as 'video',
      base64: 'aGVsbG8=',
      ext: 'mp4',
      name: 'x.mp4',
    }])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()
  })
})
