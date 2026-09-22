/**
 * Legacy slide-lifecycle channels must really mutate the deck.
 *
 * These channels (`slides:add-blank-slide`, `slides:add-slide`,
 * `slides:add-slide-with-layout`, `slides:delete-slide`, `slides:move-slide`)
 * are what the slides renderer calls from its UI — the toolbar's "new slide",
 * the sorter's drag-reorder, the context menu's duplicate/delete. Every one of
 * them used to answer the literal `{ ok: true, slideId: 'slide-<now>' }` while
 * touching nothing.
 *
 * The failure mode is worse than a missing feature, which is why it gets a
 * dedicated suite: the renderer guards those calls with `if (r)` and then takes
 * its success branch. A fabricated `{ok:true}` therefore looked like a working
 * insert — the slide count never changed, and `slides:save` then wrote a deck
 * without the user's edit. Nothing surfaced anywhere.
 *
 * The test drives the real bundle: open a deck, call the channel, SAVE, reopen,
 * and count slides. Counting after a save+reopen is the point — asserting the
 * in-memory response alone would have passed against the stub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const blankTemplate = join(pkgRoot, 'src', 'shell', 'templates', 'blank.pptx')
const skip = !existsSync(bundle) || !existsSync(blankTemplate)

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

describe.skipIf(skip)('slides legacy lifecycle channels really mutate the deck', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let deck: string

  /* The session header is what these legacy channels key on: they carry no
   * path, so the server resolves the open deck through
   * `getCurrentSlidesPath(x-ipc-session)`. Omitting it made every call answer
   * null — which is why the pre-fix stub's `{ok:true}` looked harmless. */
  const invokeAs = async (session: string, channel: string, args: unknown[]) => {
    const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ipc-session': session },
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  const invoke = (channel: string, args: unknown[]) => invokeAs('legacy-e2e', channel, args)
  const unwrap = <T = Record<string, unknown>>(body: unknown): T | undefined =>
    (body as { result?: T })?.result

  /** Slide count as the renderer sees it on open. */
  const slideCount = async (): Promise<number> => {
    const r = await invoke('slides:open-path', [deck])
    expect(r.status).toBe(200)
    return unwrap<{ slides?: unknown[] }>(r.body)?.slides?.length ?? 0
  }

  /** Persist the live model, then reopen and count — the only check the stub
   *  could not have passed. */
  const saveAndCount = async (): Promise<number> => {
    const save = await invoke('slides:save', [undefined, deck, undefined])
    expect(save.status).toBe(200)
    expect(unwrap<{ ok?: boolean }>(save.body)?.ok).toBe(true)
    return slideCount()
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-legacy-'))
    /* Band 35000+ is unused by the other suites. Every suite here binds a
     * random port and vitest runs files in parallel, so a shared band makes
     * two servers race for the same port and one suite fails with a
     * connection error that has nothing to do with its assertions. */
    const port = 35000 + Math.floor(Math.random() * 3000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 20_000)

    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    deck = join(filesDir, `legacy-${Date.now()}.pptx`)
    copyFileSync(blankTemplate, deck)
  })

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('slides:add-blank-slide grows the saved deck by one slide', async () => {
    const before = await slideCount()
    const r = await invoke('slides:add-blank-slide', [{ sourceIndex: 0, fitWidthPx: 1280 }])
    expect(r.status).toBe(200)
    const result = unwrap<{ slides?: unknown[]; index?: number }>(r.body)
    // The renderer replaces its whole list with `r.slides`; a response without
    // it was how the stub left the UI showing the old deck.
    expect(Array.isArray(result?.slides)).toBe(true)
    expect(result?.slides?.length).toBe(before + 1)
    expect(result?.index).toBe(1)
    expect(await saveAndCount()).toBe(before + 1)
  })

  it('slides:add-slide (duplicate) grows the saved deck by one slide', async () => {
    const before = await slideCount()
    const r = await invoke('slides:add-slide', [
      { sourceIndex: 0, clearText: false, fitWidthPx: 1280 },
    ])
    expect(r.status).toBe(200)
    const result = unwrap<{ slides?: unknown[]; index?: number }>(r.body)
    expect(result?.slides?.length).toBe(before + 1)
    expect(result?.index).toBe(1)
    expect(await saveAndCount()).toBe(before + 1)
  })

  it('slides:add-slide-with-layout without a layout behaves as a blank insert', async () => {
    const before = await slideCount()
    const r = await invoke('slides:add-slide-with-layout', [{ sourceIndex: 0, fitWidthPx: 1280 }])
    expect(r.status).toBe(200)
    expect(unwrap<{ slides?: unknown[] }>(r.body)?.slides?.length).toBe(before + 1)
    expect(await saveAndCount()).toBe(before + 1)
  })

  it('slides:delete-slide shrinks the saved deck by one slide', async () => {
    // Ensure there are at least two slides to remove one.
    await invoke('slides:add-blank-slide', [{ sourceIndex: 0, fitWidthPx: 1280 }])
    await invoke('slides:save', [undefined, deck, undefined])
    const before = await slideCount()
    expect(before).toBeGreaterThan(1)
    const r = await invoke('slides:delete-slide', [0])
    expect(r.status).toBe(200)
    const result = unwrap<{ slides?: unknown[] }>(r.body)
    expect(result?.slides?.length).toBe(before - 1)
    expect(await saveAndCount()).toBe(before - 1)
  })

  it('slides:move-slide reorders without changing the slide count', async () => {
    await invoke('slides:add-blank-slide', [{ sourceIndex: 0, fitWidthPx: 1280 }])
    await invoke('slides:save', [undefined, deck, undefined])
    const before = await slideCount()
    expect(before).toBeGreaterThan(1)
    const r = await invoke('slides:move-slide', [{ fromIndex: 0, toIndex: before - 1 }])
    expect(r.status).toBe(200)
    const result = unwrap<{ slides?: unknown[]; index?: number }>(r.body)
    expect(result?.slides?.length).toBe(before)
    expect(result?.index).toBe(before - 1)
    expect(await saveAndCount()).toBe(before)
  })

  it('a channel with no open session reports no mutation instead of a fake success', async () => {
    // A session that never called `slides:open-path` has no current deck, so
    // `applyLegacyMutation` answers null — matching the desktop handlers. The
    // renderer's `if (r)` guard then leaves the document alone, which is
    // honest. The old stub fabricated `{ok:true, slides:[...]}` here: an
    // invented deck for a session that had opened nothing.
    const r = await invokeAs('never-opened', 'slides:add-blank-slide', [
      { sourceIndex: 0, fitWidthPx: 1280 },
    ])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()
  })

  it('the acknowledged-no-op set stays small and declared', async () => {
    // Guards against re-growing the stub surface: the only channels allowed to
    // answer without mutating are the OS-clipboard ones, and they must send
    // `acknowledgedOnly` so a caller can tell the difference.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(join(pkgRoot, 'src', 'slides', 'elements.ts'), 'utf8'),
    )
    const declared = [...source.matchAll(/'([a-z:0-9-]+)': 'renderer owns/g)].map((m) => m[1])
    expect(declared.sort()).toEqual([
      'slides:copy-slide',
      'slides:paste-slide',
      'slides:repaste-slide',
    ])
    expect(source).toContain('acknowledgedOnly: true')
  })
})
