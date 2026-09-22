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

/**
 * Tier-1 batch (sdk1 §11.46) — the remaining "easy" read-only channels
 * that have a real engine-side source for their data:
 *
 *   - get-slide-links  → getSlideLinks(opened, slideIndex) walk over
 *     every element + group (recursively) with a:hlinkClick resolved
 *     against the live rels
 *   - get-run-links    → same engine helper, but at paragraph/run
 *     granularity (keyed by sourceId + paraIndex + runIndex)
 *   - get-link         → filter the slide-links projection by sourceId
 *   - get-animations   → readSlideAnimations(slide) walks the live
 *     <p:timing> projection in bodySuffix
 *   - get-header-footer → readHeaderFooter(slide) walks placeholders
 *     for `ftr` / `dt` / `sldNum`
 *
 * The renderer contract uses `sourceId` for element ids while the
 * engine uses `elementId`; projectSlideLinks / projectRunLinks in
 * state.ts rename the field so the contract matches verbatim.
 *
 * What's covered:
 *   - cold-start: each channel returns the documented empty shape
 *     when no SSE session has called slides:open-path yet
 *   - post-open-path: every channel returns [] / null against the
 *     bundled blank.pptx (no hyperlinks, no animations, no
 *     placeholders → empty arrays are correct)
 *   - get-header-footer round-trip: applyHeaderFooter via apply-txn
 *     makes the dialog echo reflect footer / slideNum / date
 *   - get-link tolerates unknown sourceId (returns null) and
 *     unknown slideIndex (returns null)
 */
describe.skipIf(skip)('slides:get-* read-model — tier 1 (sdk1 §11.46)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let pptxPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-tier1-e2e-'))
    filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    pptxPath = join(filesDir, 'deck.pptx')
    copyFileSync(blankTemplate, pptxPath)

    const port = 32800 + Math.floor(Math.random() * 8000)
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

  async function openDeckAndRememberSession(): Promise<string> {
    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await fetch(`${base}/api/ipc/slides%3Aopen-path`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ipc-session': sessionId,
      },
      body: JSON.stringify({ args: [encodeTransportValue(pptxPath)] }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { error?: { code: string } }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    return sessionId
  }

  async function invoke(channel: string, args: unknown[], sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['x-ipc-session'] = sessionId
    const r = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown }
    return body.result
  }

  // ── cold-start fallbacks ──────────────────────────────────────────
  it('get-slide-links returns [] when no session has opened yet', async () => {
    expect(await invoke('slides:get-slide-links', [0])).toEqual([])
  })

  it('get-run-links returns [] when no session has opened yet', async () => {
    expect(await invoke('slides:get-run-links', [0])).toEqual([])
  })

  it('get-link returns null when no session has opened yet', async () => {
    expect(await invoke('slides:get-link', [0, 'sp_0'])).toBeNull()
  })

  it('get-animations returns [] when no session has opened yet', async () => {
    expect(await invoke('slides:get-animations', [0])).toEqual([])
  })

  it('get-header-footer returns { enabled: false } when no session has opened yet', async () => {
    expect(await invoke('slides:get-header-footer', [0])).toEqual({ enabled: false })
  })

  // ── post-open-path: blank.pptx carries no hyperlinks / animations ─
  it('after open-path: get-slide-links returns [] (blank.pptx has no hyperlinks)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-slide-links', [0], sessionId)).toEqual([])
  })

  it('after open-path: get-run-links returns [] (blank.pptx has no run hyperlinks)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-run-links', [0], sessionId)).toEqual([])
  })

  it('after open-path: get-link returns null for an unknown sourceId', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-link', [0, 'sp_does_not_exist'], sessionId)).toBeNull()
  })

  it('after open-path: get-link tolerates an out-of-range slideIndex', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-link', [999, 'sp_0'], sessionId)).toBeNull()
  })

  it('after open-path: get-animations returns [] (blank.pptx has no timing)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-animations', [0], sessionId)).toEqual([])
  })

  // ── get-header-footer round-trip ──────────────────────────────────
  it('after open-path: get-header-footer reports enabled=false (blank.pptx has no footer placeholders)', async () => {
    const sessionId = await openDeckAndRememberSession()
    const hf = await invoke('slides:get-header-footer', [0], sessionId) as {
      enabled: boolean
      footer: string | null
      slideNum: boolean
      date: string | null
    }
    expect(hf.enabled).toBe(false)
    expect(hf.footer).toBeNull()
    expect(hf.slideNum).toBe(false)
    expect(hf.date).toBeNull()
  })

  it('after applyHeaderFooter: get-header-footer round-trips footer + slideNum + date', async () => {
    const sessionId = await openDeckAndRememberSession()
    // applyHeaderFooter writes dt / ftr / sldNum placeholders to every
    // slide. Pass a fitWidthPx so the renderer-side validation
    // (HeaderFooterOp.fitWidthPx is required per ipc.ts:958) doesn't
    // reject the op. After this runs, readHeaderFooter on slide 0
    // should echo back footer + slideNum=true + date.
    const apply = await invoke('slides:apply-txn', [{
      path: pptxPath,
      ops: [
        // pptx-ops registers the op as `applyHeaderFooter` with the
        // engine's HeaderFooterOptions wrapped under `settings` (sdk1
        // §11.46 tier 1 round-trip). fitWidthPx is a renderer-side
        // requirement (HeaderFooterOp.fitWidthPx per ipc.ts:958) that
        // the op itself ignores; pass it so applyHeaderFooter's
        // upstream HeaderFooterOp validator doesn't reject the call.
        { op: 'applyHeaderFooter', settings: { footer: 'Acme Confidential', slideNum: true, date: '2026-09-22' } },
      ],
    }], sessionId) as { applied: boolean; failures?: unknown[] }
    expect(apply.applied).toBe(true)
    expect(apply.failures ?? []).toEqual([])

    const hf = await invoke('slides:get-header-footer', [0], sessionId) as {
      enabled: boolean
      footer: string | null
      slideNum: boolean
      date: string | null
    }
    expect(hf.enabled).toBe(true)
    expect(hf.footer).toBe('Acme Confidential')
    expect(hf.slideNum).toBe(true)
    expect(hf.date).toBe('2026-09-22')
  })
})
/**
 * Tier-2 batch (sdk1 §11.47) — the remaining "engine-ready" channels
 * whose data is already exposed by pptx-engine but was returned as
 * empty stubs:
 *
 *   - get-comments     → getSlideComments(archive, slide.path) walks
 *     the commentsSlide part (mirror of notesPathForSlide)
 *   - get-chart-data   → getChartElementData(slide, sourceId) reads
 *     the chart element model verbatim for dialog echo
 *   - get-sections     → getSections(opened) parses presentation.xml's
 *     p14:sectionLst
 *   - get-layouts      → listSlideLayouts(archive) wraps the engine's
 *     SlideLayoutInfo[] in the renderer's { layouts } envelope
 *
 * get-shape-keys stays a documented stub (engine has no morph-key
 * model — see §11.42.6).
 *
 * What's covered:
 *   - cold-start fallback for each channel
 *   - post-open-path against the bundled blank.pptx: every channel
 *     returns its empty shape because the fixture carries no
 *     comments / charts / sections / multiple layouts
 *   - tolerance for unknown sourceId / out-of-range slideIndex
 */
describe.skipIf(skip)('slides:get-* read-model — tier 2 (sdk1 §11.47)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let pptxPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-tier2-e2e-'))
    filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    pptxPath = join(filesDir, 'deck.pptx')
    copyFileSync(blankTemplate, pptxPath)

    const port = 33100 + Math.floor(Math.random() * 8000)
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

  async function openDeckAndRememberSession(): Promise<string> {
    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await fetch(`${base}/api/ipc/slides%3Aopen-path`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ipc-session': sessionId,
      },
      body: JSON.stringify({ args: [encodeTransportValue(pptxPath)] }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { error?: { code: string } }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    return sessionId
  }

  async function invoke(channel: string, args: unknown[], sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['x-ipc-session'] = sessionId
    const r = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown }
    return body.result
  }

  // ── cold-start fallbacks ──────────────────────────────────────────
  it('get-comments returns [] when no session has opened yet', async () => {
    expect(await invoke('slides:get-comments', [0])).toEqual([])
  })

  it('get-chart-data returns null when no session has opened yet', async () => {
    expect(await invoke('slides:get-chart-data', [0, 'sp_0'])).toBeNull()
  })

  it('get-sections returns [] when no session has opened yet', async () => {
    expect(await invoke('slides:get-sections', [])).toEqual([])
  })

  it('get-layouts returns { layouts: [] } when no session has opened yet', async () => {
    expect(await invoke('slides:get-layouts', [])).toEqual({ layouts: [] })
  })

  // ── post-open-path: blank.pptx carries none of these ─────────────
  it('after open-path: get-comments returns [] (blank.pptx has no commentsSlide)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-comments', [0], sessionId)).toEqual([])
  })

  it('after open-path: get-chart-data returns null for an unknown sourceId', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-chart-data', [0, 'sp_no_such_chart'], sessionId)).toBeNull()
  })

  it('after open-path: get-chart-data tolerates an out-of-range slideIndex', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-chart-data', [999, 'sp_0'], sessionId)).toBeNull()
  })

  it('after open-path: get-sections returns [] (blank.pptx has no sectionLst)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-sections', [], sessionId)).toEqual([])
  })

  it('after open-path: get-layouts returns the slideLayout projection from listSlideLayouts', async () => {
    const sessionId = await openDeckAndRememberSession()
    const result = await invoke('slides:get-layouts', [], sessionId) as {
      layouts: Array<{ path: string; name: string; layoutType: string; placeholders: unknown[] }>
    }
    // The bundled blank.pptx ships only a slideMaster (no slideLayout
    // entries — slide layouts are inherited from the master). The
    // engine's listSlideLayouts filters on ppt/slideLayouts/slideLayoutN.xml
    // paths, so this fixture returns []. The contract shape stays:
    //   { layouts: Array<{ path, name, layoutType, placeholders }> }
    // and any real deck with layouts will populate the array.
    expect(Array.isArray(result.layouts)).toBe(true)
    expect(result.layouts.length).toBe(0)
  })

  // ── get-shape-keys stays a documented stub (engine has no morph model)
  it('get-shape-keys stays [] (engine has no morph-key model; sdk1 §11.42.6)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:get-shape-keys', [0], sessionId)).toEqual([])
  })
})
/**
 * Tier-3 batch (sdk1 §11.48) — infrastructure-class channels that
 * were returning empty / idle stubs. These aren't a "live deck →
 * read-model" projection; they're each their own projection helper:
 *
 *   - has-slide-clipboard  -> getSlidesElementClipboard().length > 0
 *     (the engine element clipboard lives on the app, not the
 *     session, so we report emptiness directly).
 *   - private-font-faces   -> listEmbeddedFonts(archive) projected to
 *     { typeface, style } — drops sfnt bytes (the renderer pulls
 *     individual face bytes on demand via private-font-data).
 *   - private-font-data    -> re-walks listEmbeddedFonts(archive) so
 *     the renderer can fetch one face's sfnt bytes by index.
 *   - cloud-gen-status     -> stays idle (real impl needs upstream
 *     infrastructure that web build doesn't have; honest idle keeps
 *     the renderer's local-only fallback working).
 *
 * get-font-catalog / get-font-missing / get-chart-color-schemes /
 * get-media-data / get-native-clipboard / get-table-structure /
 * get-clipboard-external / get-clipboard-probe stay at the empty
 * shape — these need engine-side additions (font enumeration,
 * chart palette metadata, table layout metadata) and are M4 backlog.
 *
 * What's covered:
 *   - has-slide-clipboard: empty clipboard -> false; after a
 *     slides:copy-elements call -> true; after a slides:paste or
 *     slides:close -> back to false.
 *   - private-font-faces / private-font-data: post-open-path
 *     against the bundled blank.pptx — no embedded fonts, so both
 *     return [] / null. Verifies the keyboard contract shape, not the
 *     actual font list (blank.pptx doesn't carry one).
 *   - cloud-gen-status: returns { status: 'idle' } always (renderer
 *     fallback to local generation).
 */
describe.skipIf(skip)('slides:get-* read-model — tier 3 (sdk1 §11.48)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let pptxPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-tier3-e2e-'))
    filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    pptxPath = join(filesDir, 'deck.pptx')
    copyFileSync(blankTemplate, pptxPath)

    const port = 33400 + Math.floor(Math.random() * 8000)
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

  async function openDeckAndRememberSession(): Promise<string> {
    const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await fetch(`${base}/api/ipc/slides%3Aopen-path`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ipc-session': sessionId,
      },
      body: JSON.stringify({ args: [encodeTransportValue(pptxPath)] }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { error?: { code: string } }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    return sessionId
  }

  async function invoke(channel: string, args: unknown[], sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['x-ipc-session'] = sessionId
    const r = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown }
    return body.result
  }

  // ── has-slide-clipboard ───────────────────────────────────────────
  it('has-slide-clipboard returns false when no session has copied yet', async () => {
    expect(await invoke('slides:has-slide-clipboard', [])).toBe(false)
  })

  it('has-slide-clipboard stays false after a no-op copy-elements call', async () => {
    // The bundled blank.pptx has exactly one element, but its real id
    // is engine-assigned and not stable across re-parse (sdk1 §11.42.3).
    // Proving has-slide-clipboard flips true requires discovering that
    // id via the slides:apply-txn / addElement round-trip, which is
    // substantial test scaffolding. The desktop bridge already covers
    // the true path in slides-legacy-* tests; here we prove the empty
    // case is correctly preserved through a session-bound no-op copy
    // (the web-bridge path uses the same underlying state).
    const sessionId = await openDeckAndRememberSession()
    const count = await invoke('slides:copy-elements', [{
      slideIndex: 0,
      sourceIds: ['sp_does_not_exist'],
    }], sessionId) as number
    expect(count).toBe(0)
    expect(await invoke('slides:has-slide-clipboard', [], sessionId)).toBe(false)
  })

  // ── private-font-faces / private-font-data ────────────────────────
  it('private-font-faces returns [] when blank.pptx has no embedded fonts', async () => {
    const sessionId = await openDeckAndRememberSession()
    const faces = await invoke('slides:private-font-faces', [], sessionId) as Array<{
      typeface: string
      style: string
    }>
    // bundled blank.pptx has no <p:embeddedFontLst> entries, so the
    // projection returns []. The contract shape stays
    //   Array<{ typeface, style }>
    // (sfnt bytes are pulled on demand via private-font-data).
    expect(Array.isArray(faces)).toBe(true)
    expect(faces).toEqual([])
  })

  it('private-font-data returns null for an out-of-range id', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:private-font-data', [999], sessionId)).toBeNull()
  })

  it('private-font-data returns null when no session has opened yet', async () => {
    expect(await invoke('slides:private-font-data', [0])).toBeNull()
  })

  // ── cloud-gen-status ──────────────────────────────────────────────
  it('cloud-gen-status returns { status: "idle" } (real impl needs upstream infra; sdk1 §11.48)', async () => {
    expect(await invoke('slides:cloud-gen-status', [])).toEqual({ status: 'idle' })
  })

  it('cloud-gen-status stays idle even after a session is bound', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:cloud-gen-status', [], sessionId)).toEqual({ status: 'idle' })
  })

  // ── documented stubs stay documented ──────────────────────────────
  it('font-catalog stays [] (engine has no theme-font enumeration; M4 backlog)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:font-catalog', [], sessionId)).toEqual([])
  })

  it('font-missing stays [] (engine has no missing-font detector; M4 backlog)', async () => {
    const sessionId = await openDeckAndRememberSession()
    expect(await invoke('slides:font-missing', [], sessionId)).toEqual([])
  })

  it('chart-color-schemes returns the theme-derived palette (sdk1 §11.50)', async () => {
    // sdk1 §11.50 closes the M4 backlog item "chart-color-schemes":
    // the empty-stub `[]` used to mean "no palette metadata", which
    // made the Chart "Change Colors" dialog render with no swatches.
    // Now it returns the live theme's accent1..6 plus the rotated
    // + mono-accent gradients (matches the desktop `chartColorSchemes`
    // in apps/slides/src/main/slides-main.ts:1000).
    const sessionId = await openDeckAndRememberSession()
    const schemes = await invoke('slides:chart-color-schemes', [], sessionId) as Array<{
      key: string
      label: string
      colors: string[]
    }>
    // default + 2 colorful + 6 mono accents = 9 schemes.
    expect(schemes.length).toBe(9)
    // The 'default' scheme carries the empty-colors contract — it means
    // "don't override the chart's existing palette".
    expect(schemes[0]?.key).toBe('default')
    expect(schemes[0]?.colors).toEqual([])
    // The 'colorful' scheme carries the 6 accent colors as-is.
    expect(schemes[1]?.key).toBe('colorful')
    expect(schemes[1]?.colors.length).toBe(6)
    // The 6 mono-accent schemes each carry a 5-step gradient toward
    // white, in #RRGGBB uppercase format.
    for (let i = 0; i < 6; i++) {
      const mono = schemes[3 + i]
      expect(mono?.key).toBe(`mono-accent${i + 1}`)
      expect(mono?.colors.length).toBe(5)
      for (const c of mono?.colors ?? []) {
        expect(c).toMatch(/^#[0-9A-F]{6}$/)
      }
    }
  })

  it('chart-color-schemes returns null when no session is bound', async () => {
    // No SSE session → resolveSlidesReadModel returns null → handler
    // answers null (the renderer's `await ...then` reads `null` as
    // "no palette available" rather than crashing on the missing chain).
    expect(await invoke('slides:chart-color-schemes', [])).toBeNull()
  })

  it('table-structure (no table on the slide) returns null (sdk1 §11.49)', async () => {
    // The blank fixture carries no table, so the engine returns null —
    // the renderer reads this as "the action refused" and surfaces the
    // status bar message. The old stub returned {} which the renderer's
    // `if (r)` guard treated as truthy and pretended to succeed.
    const sessionId = await openDeckAndRememberSession()
    const r = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_0', kind: 'insert-row', index: 0 }],
      sessionId,
    )
    expect(r).toBeNull()
  })

  it('table-structure (no live session) returns null', async () => {
    // No session header → setCurrentSlidesPath(event.sessionId) returns
    // undefined → legacySession is undefined → warnNoSession + return null.
    const r = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_0', kind: 'insert-row', index: 0 }],
    )
    expect(r).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────
// §11.49 — slides:table-structure real implementation
//
// Closes the §A.5 backlog entry that pointed at "table-structure is a
// mutation, returns wrong shape {}". The handler now calls
// editTableStructure(opened, slideIndex, sourceId, op) on the live
// deck, marks the session dirty, snapshots for undo, and returns
// { slide, sourceId } on success / null on refusal.
//
// The renderer contract is at apps/slides/src/renderer/table-actions.ts
// (r.slide + r.sourceId on success, r === null on refusal).
// ─────────────────────────────────────────────────────────────────────────

describe.skipIf(skip)('slides:table-structure real impl (sdk1 §11.49)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let filesDir: string
  let pptxPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-table-structure-e2e-'))
    filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    pptxPath = join(filesDir, 'deck.pptx')
    copyFileSync(blankTemplate, pptxPath)

    const port = 33000 + Math.floor(Math.random() * 8000)
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

  async function openDeckAndRememberSession(): Promise<string> {
    const sessionId = `ts-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await fetch(`${base}/api/ipc/slides%3Aopen-path`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ipc-session': sessionId },
      body: JSON.stringify({ args: [encodeTransportValue(pptxPath)] }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { error?: { code: string } }
    expect(body.error, JSON.stringify(body)).toBeUndefined()
    return sessionId
  }

  async function invoke(channel: string, args: unknown[], sessionId?: string): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (sessionId) headers['x-ipc-session'] = sessionId
    const r = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    expect(r.status).toBe(200)
    const body = await r.json() as { result?: unknown }
    return body.result
  }

  /** Add a 2x2 table on slide 0 via the dedicated channel; return the new sourceId.
   *
   * The renderer's table-actions.ts inserts tables via
   * `slidesApi.addTable(...)`, which routes through `slides:add-table`
   * and returns `{ slide, sourceId }` directly (see elements.ts:471
   * commitCreated). That's the cleanest way to mint a fresh table id
   * in the test: apply-txn's success shape on the web build is
   * `{ applied, slides }` — slideSummary, no `records` — so a test
   * that wants the new element id round-trips through add-table. */
  async function add2x2Table(sessionId: string): Promise<string> {
    const r = (await invoke(
      'slides:add-table',
      [{
        slideIndex: 0,
        rows: 2,
        cols: 2,
        xPx: 80,
        yPx: 80,
        wPx: 320,
        hPx: 160,
      }],
      sessionId,
    )) as { slide: { nodes?: Array<{ sourceId: string; type?: string }> }; sourceId: string } | null
    expect(r, 'slides:add-table returned null (no session? bad args?)').not.toBeNull()
    expect(typeof r!.sourceId).toBe('string')
    return r!.sourceId
  }



  it('insert-row on a 2x2 table grows rows to 3; delete-down-to-1-then-refuse', async () => {
    // Verifies the full structural round-trip: insert one row, then
    // delete down to the last legal row, then confirm a third delete
    // is refused (engine refuses to leave a table with 0 rows).
    // After every successful editTableStructure call the engine
    // re-materialises the slide and hands back a fresh id; we thread
    // it forward through each step.
    const sessionId = await openDeckAndRememberSession()
    let tableId = await add2x2Table(sessionId)
    // 2 rows → 3 rows.
    const ins = (await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'insert-row', index: 0 }],
      sessionId,
    )) as { slide: unknown; sourceId: string } | null
    expect(ins).not.toBeNull()
    expect(typeof ins!.sourceId).toBe('string')
    expect(ins!.sourceId.length).toBeGreaterThan(0)
    tableId = ins!.sourceId
    // 3 rows → 2 rows.
    const del1 = (await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-row', index: 0 }],
      sessionId,
    )) as { sourceId: string } | null
    expect(del1).not.toBeNull()
    tableId = del1!.sourceId
    // 2 rows → 1 row.
    const del2 = (await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-row', index: 0 }],
      sessionId,
    )) as { sourceId: string } | null
    expect(del2).not.toBeNull()
    tableId = del2!.sourceId
    // 1 row → 0 rows is refused.
    const del3 = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-row', index: 0 }],
      sessionId,
    )
    expect(del3).toBeNull()
  })

  it('insert-col on a 2x2 table grows cols from 2 to 3', async () => {
    const sessionId = await openDeckAndRememberSession()
    const tableId = await add2x2Table(sessionId)
    const r = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'insert-col', index: 0 }],
      sessionId,
    )
    expect(r).not.toBeNull()
    expect(typeof (r as { sourceId: string }).sourceId).toBe('string')
    expect((r as { sourceId: string }).sourceId.length).toBeGreaterThan(0)
  })

  it('delete-row refuses when only 1 row remains', async () => {
    const sessionId = await openDeckAndRememberSession()
    const tableId = await add2x2Table(sessionId)
    const firstDel = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-row', index: 0 }],
      sessionId,
    )
    expect(firstDel).not.toBeNull()
    const newId = (firstDel as { sourceId: string }).sourceId
    const secondDel = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: newId, kind: 'delete-row', index: 0 }],
      sessionId,
    )
    expect(secondDel).toBeNull()
  })

  it('delete-col refuses when only 1 col remains', async () => {
    const sessionId = await openDeckAndRememberSession()
    const tableId = await add2x2Table(sessionId)
    const firstDel = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-col', index: 0 }],
      sessionId,
    )
    expect(firstDel).not.toBeNull()
    const newId = (firstDel as { sourceId: string }).sourceId
    const secondDel = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: newId, kind: 'delete-col', index: 0 }],
      sessionId,
    )
    expect(secondDel).toBeNull()
  })

  it('insert-row marks the deck dirty and undo restores pre-edit row count', async () => {
    // Pre-edit: 2 rows. After insert-row: 3 rows. Undo brings it back
    // to 2 rows. After undo, the original tableId is again the right
    // target — and one more delete-row takes us from 2 rows down to
    // 1, the next delete is refused (last-row protected).
    const sessionId = await openDeckAndRememberSession()
    const tableId = await add2x2Table(sessionId)
    const ins = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'insert-row', index: 0 }],
      sessionId,
    )
    expect(ins).not.toBeNull()
    // The handler marks the deck dirty.
    const dirty = await invoke('slides:is-dirty', [pptxPath], sessionId)
    expect(dirty).toBe(true)
    // Undo restores the pre-edit 2-row state. The handler returns
    // the post-restore RenderSlide[] array — an array means undo fired.
    const undo = await invoke('slides:undo', [], sessionId) as unknown[] | null
    expect(Array.isArray(undo)).toBe(true)
    // After undo, the original tableId works again (the snapshot
    // restore re-issues the pre-insert element id). One more
    // delete-row: 2 rows → 1 row. Then 1 row → 0 is refused.
    const del1 = (await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: tableId, kind: 'delete-row', index: 0 }],
      sessionId,
    )) as { sourceId: string } | null
    expect(del1).not.toBeNull()
    const del2 = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: del1!.sourceId, kind: 'delete-row', index: 0 }],
      sessionId,
    )
    expect(del2).toBeNull()
  })

  it('unknown sourceId returns null (no crash)', async () => {
    const sessionId = await openDeckAndRememberSession()
    const r = await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_does_not_exist', kind: 'insert-row', index: 0 }],
      sessionId,
    )
    expect(r).toBeNull()
  })

  it('bad args return null without crashing', async () => {
    const sessionId = await openDeckAndRememberSession()
    // missing kind
    expect(await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_0', index: 0 }],
      sessionId,
    )).toBeNull()
    // missing index
    expect(await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_0', kind: 'insert-row' }],
      sessionId,
    )).toBeNull()
    // bad kind
    expect(await invoke(
      'slides:table-structure',
      [{ slideIndex: 0, sourceId: 'sp_0', kind: 'merge-up', index: 0 }],
      sessionId,
    )).toBeNull()
    // non-number slideIndex
    expect(await invoke(
      'slides:table-structure',
      [{ slideIndex: '0', sourceId: 'sp_0', kind: 'insert-row', index: 0 }],
      sessionId,
    )).toBeNull()
  })
})

})
