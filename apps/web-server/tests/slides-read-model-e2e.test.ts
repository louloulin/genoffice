/**
 * Slides read-model e2e — verifies the live read-model behind the
 * `slides:get-slide-size` / `slides:get-notes` / `slides:get-render-slides`
 * channels (sdk1.md §11.45 — partial M4 head-start).
 *
 * These three were returning empty / default stubs before this commit:
 *
 *   - `slides:get-slide-size` → hardcoded { width: 960, height: 540 }.
 *     Wrong for any 4:3 / a4 / custom-size deck — the renderer's canvas
 *     would render at the wrong aspect ratio until it parsed the deck
 *     itself.
 *   - `slides:get-notes` → "". PowerPoint's notes pane was always empty
 *     on the web build, even when the file carried them.
 *   - `slides:get-render-slides` → []. The slide strip / thumbnails
 *     were blank.
 *
 * Now they read the live `OpenedPptx.deck` (the in-memory model that
 * `slides:apply-txn` mutates), so edits show up on the next call without
 * a re-parse. The fix uses a shared `resolveSlidesReadModel` helper so
 * the remaining ~22 read-only get-* channels (sdk1 §11.42.6 M4) have a
 * template to follow.
 *
 * What's covered:
 *   - Cold-start fallback: each channel returns the documented default
 *     shape when no SSE session has called slides:open-path yet.
 *   - After open-path, each channel reads from the live deck:
 *     - slide-size matches the pptx EMU dimensions converted to px
 *       at 96 DPI (9525 EMU/px);
 *     - notes picks up the notesSlide part when one exists;
 *     - render-slides returns one projection per slide with index,
 *       hidden (via getSlideHidden), hasNotes (via notesPathForSlide),
 *       and name (parsed from p:cSld@name).
 *   - Live mutation: setSlideHidden via apply-txn flips the
 *     hidden bit visible to get-render-slides on the next call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const blankTemplate = join(pkgRoot, 'src', 'shell', 'templates', 'blank.pptx')
const haveFixture = existsSync(blankTemplate)
const haveBundle = existsSync(bundle)
const skip = !haveBundle || !haveFixture

async function pollHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error(`server did not become healthy within ${deadlineMs}ms`)
}

describe.skipIf(skip)('slides:get-* read-model (sdk1 §11.45)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let pptxPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-read-e2e-'))
    filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    pptxPath = join(filesDir, 'deck.pptx')
    copyFileSync(blankTemplate, pptxPath)

    const port = 32500 + Math.floor(Math.random() * 8000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      cwd: pkgRoot,
      env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 15_000)
  }, 30_000)

  afterAll(async () => {
    if (server) await stopServer(server)
    rmSync(dataDir, { recursive: true, force: true })
  })

  // Helper: open the deck and remember the SSE session id; every
  // subsequent call reuses it so `setCurrentSlidesPath` resolves.
  async function openDeckAndRememberSession(): Promise<string> {
    // The IPC client opens an SSE channel for live events; we don't need
    // it for these read-model tests, but we still need the session id so
    // getCurrentSlidesPath(event.sessionId) resolves inside the server.
    // open-path accepts no session id; we mint one here and pass it on
    // every call.
    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await fetch(`${base}/api/ipc/slides%3Aopen-path`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ipc-session': sessionId,
      },
      body: JSON.stringify({
        args: [encodeTransportValue(pptxPath)],
      }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown; error?: { code: string } }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    return sessionId
  }

  async function invoke(channel: string, args: unknown[], sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['x-ipc-session'] = sessionId
    const r = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        args: args.map((a) => encodeTransportValue(a)),
      }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown }
    return body.result
  }

  it('get-slide-size returns the 16:9 fallback when no session has opened yet', async () => {
    const r = await invoke('slides:get-slide-size', [])
    expect(r).toEqual({ width: 960, height: 540 })
  })

  it('get-notes returns "" when no session has opened yet', async () => {
    const r = await invoke('slides:get-notes', [0])
    expect(r).toBe('')
  })

  it('get-render-slides returns [] when no session has opened yet', async () => {
    const r = await invoke('slides:get-render-slides', [])
    expect(r).toEqual([])
  })

  it('after open-path: get-slide-size returns the deck dimensions in px (96 DPI)', async () => {
    const sessionId = await openDeckAndRememberSession()
    // The blank template is a default Office 16:9 deck: 9144000 x
    // 5143500 EMU = 10" x 5.625" at 96 DPI = 960 x 540 px.
    const size = await invoke('slides:get-slide-size', [], sessionId) as { width: number; height: number }
    // The blank template ships as a 4:3 deck: 9144000 x 6858000 EMU = 10"
    // x 7.5" at 96 DPI = 960 x 720 px. The previous hardcoded 960x540
    // fallback was wrong for this exact fixture — which is precisely why
    // sdk1 §11.45 moved the handler to the live model.
    expect(size.width).toBe(960)
    expect(size.height).toBe(720)
  })

  it('after open-path: get-render-slides returns one projection per slide', async () => {
    const sessionId = await openDeckAndRememberSession()
    const slides = await invoke('slides:get-render-slides', [], sessionId) as Array<{
      index: number
      hidden: boolean
      hasNotes: boolean
      name: string
    }>
    expect(slides.length).toBeGreaterThan(0)
    // The blank template ships one slide.
    expect(slides.length).toBe(1)
    expect(slides[0]?.index).toBe(0)
    expect(slides[0]?.hidden).toBe(false)
    expect(slides[0]?.hasNotes).toBe(false)
    expect(slides[0]?.name).toMatch(/^Slide \d+$/)
  })

  it('after open-path: get-notes returns "" for an out-of-range slideIndex', async () => {
    const sessionId = await openDeckAndRememberSession()
    const r = await invoke('slides:get-notes', [999], sessionId)
    expect(r).toBe('')
  })

  it('after open-path: get-notes tolerates a non-number slideIndex', async () => {
    const sessionId = await openDeckAndRememberSession()
    const r = await invoke('slides:get-notes', ['not-a-number'], sessionId)
    expect(r).toBe('')
  })

  it('after open-path: get-notes round-trips text set via setSlideNotes', async () => {
    const sessionId = await openDeckAndRememberSession()
    // Mutate notes through apply-txn so the projection picks up the
    // live archive.
    const applyResult = await invoke('slides:apply-txn', [{
      // apply-txn (sdk1 §11.42) requires { path, ops }; the SSE session
      // id alone isn't enough — the dispatcher resolves the live model
      // by path, not by sessionId.
      path: pptxPath,
      ops: [
        // pptx-ops registers the op as `setNotes` (sdk1 §11.42 anchor
        // match); the slide is addressed through `target: { slide }` —
        // see `resolveSlide` in packages/pptx-ops/src/ops/registry.ts.
        { op: 'setNotes', target: { slide: 0 }, text: 'Speaker note line 1\nLine 2' },
      ],
    }], sessionId) as { applied: boolean; failures?: unknown[] }
    expect(applyResult.applied).toBe(true)
    expect(applyResult.failures ?? []).toEqual([])

    const notes = await invoke('slides:get-notes', [0], sessionId) as string
    expect(notes).toBe('Speaker note line 1\nLine 2')

    // The render-slides projection should now reflect hasNotes=true.
    const slides = await invoke('slides:get-render-slides', [], sessionId) as Array<{ hasNotes: boolean }>
    expect(slides[0]?.hasNotes).toBe(true)
  })

  it('after open-path: get-render-slides reflects hidden=true after setSlideHidden', async () => {
    const sessionId = await openDeckAndRememberSession()
    const applyResult = await invoke('slides:apply-txn', [{
      path: pptxPath,
      ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }],
    }], sessionId) as { applied: boolean; failures?: unknown[] }
    expect(applyResult.applied).toBe(true)

    const slides = await invoke('slides:get-render-slides', [], sessionId) as Array<{ hidden: boolean }>
    expect(slides[0]?.hidden).toBe(true)

    // Flip back so a follow-up save test sees the original state.
    await invoke('slides:apply-txn', [{
      path: pptxPath,
      ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: false }],
    }], sessionId)
  })
})
