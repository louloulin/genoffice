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

  /* Serve each element test a FRESH copy of the template. Sharing one deck
   * across cases made them order-dependent: elements accumulated, so
   * `nodes[0]` was whatever an earlier case inserted (a rect, not the text box
   * a later case needs). A per-test file also means one case's saved edits
   * cannot mask another's. */
  const freshDeck = async (label: string): Promise<string> => {
    const path = join(dataDir, 'files', `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.pptx`)
    copyFileSync(blankTemplate, path)
    // Open it too: the legacy channels carry no path, so they act on whatever
    // this SSE session last opened. Without the open every mutation answers
    // `null` (correctly — there is no live model) and the test would be
    // asserting on a channel that never ran.
    const r = await invoke('slides:open-path', [path])
    expect(r.status).toBe(200)
    return path
  }

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

  /* ── element channels ────────────────────────────────────────────────────
   * The same bug class as the slide-lifecycle channels, and worse: these
   * answer `RenderSlide | null`, and the renderer does
   * `.then((r) => r && applySlide(current, r))`. The stub's `{ok:true}` is
   * truthy, so the renderer replaced the page with an object that has no
   * `nodes` — the canvas went blank and every later edit compounded from a
   * corrupt page. Each case below proves the mutation reached the SAVED file,
   * which is the only check the stub could not have passed.
   */

  it('slides:add-element really inserts and reports the id the op minted', async () => {
    deck = await freshDeck('add-el')
    const before = await slideCount()
    const r = await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 10, yPx: 10, wPx: 200, hPx: 100, fitWidthPx: 1280 },
    ])
    expect(r.status).toBe(200)
    const created = unwrap<{ slide?: { nodes?: unknown[] }; sourceId?: string }>(r.body)
    // `{slide, sourceId}` — a fabricated `elementId: 'element-<now>'` made the
    // renderer select something that did not exist.
    expect(Array.isArray(created?.slide?.nodes)).toBe(true)
    expect(created?.slide?.nodes?.length).toBe(1)
    expect(typeof created?.sourceId).toBe('string')

    // The element must survive a save+reopen, not just the in-memory response.
    const save = await invoke('slides:save', [undefined, deck, undefined])
    expect(unwrap<{ ok?: boolean }>(save.body)?.ok).toBe(true)
    const reopened = await invoke('slides:open-path', [deck])
    const nodes = unwrap<{ slides?: Array<{ nodes?: unknown[] }> }>(reopened.body)?.slides?.[0]
      ?.nodes
    expect(nodes?.length).toBe(1)
    expect(await saveAndCount()).toBe(before)
  })

  it('slides:delete-element removes the element from the saved file', async () => {
    deck = await freshDeck('del-el')
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 10, yPx: 10, wPx: 120, hPx: 80, fitWidthPx: 1280 },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const first = unwrap<{ slides?: Array<{ nodes?: Array<{ sourceId?: string }> }> }>(opened.body)
      ?.slides?.[0]?.nodes?.[0]
    expect(first?.sourceId).toBeTruthy()

    const r = await invoke('slides:delete-element', [
      { slideIndex: 0, sourceId: first!.sourceId },
    ])
    expect(r.status).toBe(200)
    const slide = unwrap<{ nodes?: unknown[] }>(r.body)
    expect(Array.isArray(slide?.nodes)).toBe(true)
    expect(slide?.nodes?.length).toBe(0)

    await invoke('slides:save', [undefined, deck, undefined])
    const reopened = await invoke('slides:open-path', [deck])
    const nodes = unwrap<{ slides?: Array<{ nodes?: unknown[] }> }>(reopened.body)?.slides?.[0]
      ?.nodes
    expect(nodes?.length).toBe(0)
  })

  it('slides:edit-transform moves the element and persists the new box', async () => {
    deck = await freshDeck('transform')
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 10, yPx: 10, wPx: 100, hPx: 60, fitWidthPx: 1280 },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const node = unwrap<{
      slides?: Array<{ nodes?: Array<{ sourceId?: string; box?: { x: number; y: number } }> }>
    }>(opened.body)?.slides?.[0]?.nodes?.[0]
    expect(node?.sourceId).toBeTruthy()

    const r = await invoke('slides:edit-transform', [
      {
        slideIndex: 0,
        sourceId: node!.sourceId,
        xPx: 400,
        yPx: 250,
        wPx: 100,
        hPx: 60,
        rotationDeg: 0,
        fitWidthPx: 1280,
      },
    ])
    expect(r.status).toBe(200)
    const moved = unwrap<{ nodes?: Array<{ box?: { x: number; y: number } }> }>(r.body)
    expect(moved?.nodes?.[0]?.box?.x).toBe(400)

    // Reopen: the op must have written through to the archive, not just moved
    // the in-memory render tree.
    await invoke('slides:save', [undefined, deck, undefined])
    const again = await invoke('slides:open-path', [deck])
    const persisted = unwrap<{
      slides?: Array<{ nodes?: Array<{ box?: { x: number; y: number } }> }>
    }>(again.body)?.slides?.[0]?.nodes?.[0]
    expect(persisted?.box?.x).toBe(400)
  })

  it('slides:undo really reverts the deck, not just the response', async () => {
    deck = await freshDeck('undo')
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 5, yPx: 5, wPx: 90, hPx: 50, fitWidthPx: 1280 },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const withEl = await invoke('slides:open-path', [deck])
    const count = unwrap<{ slides?: Array<{ nodes?: unknown[] }> }>(withEl.body)?.slides?.[0]?.nodes
      ?.length
    expect(count).toBe(1)

    // Contract: `RenderSlide[] | null` — the renderer replaces every page.
    const r = await invoke('slides:undo', [])
    expect(r.status).toBe(200)
    const after = unwrap<Array<{ nodes?: unknown[] }>>(r.body)
    expect(Array.isArray(after)).toBe(true)
    expect(after[0]?.nodes?.length).toBe(0)

    await invoke('slides:save', [undefined, deck, undefined])
    const reopened = await invoke('slides:open-path', [deck])
    const persisted = unwrap<{ slides?: Array<{ nodes?: unknown[] }> }>(reopened.body)?.slides?.[0]
      ?.nodes
    expect(persisted?.length).toBe(0)
  })

  it('slides:undo with nothing to undo answers null (not a fake success)', async () => {
    // Fresh session, freshly reopened deck: the history stack is empty.
    const r = await invokeAs('undo-empty-session', 'slides:open-path', [deck])
    expect(r.status).toBe(200)
    const u = await invokeAs('undo-empty-session', 'slides:undo', [])
    expect(u.status).toBe(200)
    expect(unwrap(u.body)).toBeNull()
  })

  it('slides:copy-elements answers a count and paste really adds the copies', async () => {
    deck = await freshDeck('copy-paste')
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 20, yPx: 20, wPx: 80, hPx: 40, fitWidthPx: 1280 },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const id = unwrap<{ slides?: Array<{ nodes?: Array<{ sourceId?: string }> }> }>(opened.body)
      ?.slides?.[0]?.nodes?.[0]?.sourceId
    expect(id).toBeTruthy()

    // Contract: `Promise<number>` — the renderer tests `n > 0` before enabling
    // Paste, so `{ok:true}` made the comparison always false.
    const copied = await invoke('slides:copy-elements', [{ slideIndex: 0, sourceIds: [id] }])
    expect(copied.status).toBe(200)
    expect(unwrap<number>(copied.body)).toBe(1)

    const pasted = await invoke('slides:paste-elements', [
      { slideIndex: 0, dxPx: 40, dyPx: 40, fitWidthPx: 1280 },
    ])
    expect(pasted.status).toBe(200)
    const res = unwrap<{ slide?: { nodes?: unknown[] }; sourceIds?: string[] }>(pasted.body)
    expect(Array.isArray(res?.slide?.nodes)).toBe(true)
    expect(res?.slide?.nodes?.length).toBe(2)
    expect(res?.sourceIds?.length).toBe(1)
    expect(res?.sourceIds?.[0]).not.toBe(id)
  })

  it('slides:group-elements returns the real group id the op created', async () => {
    deck = await freshDeck('group')
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 10, yPx: 10, wPx: 60, hPx: 40, fitWidthPx: 1280 },
    ])
    await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'rect', xPx: 100, yPx: 10, wPx: 60, hPx: 40, fitWidthPx: 1280 },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const ids = unwrap<{ slides?: Array<{ nodes?: Array<{ sourceId?: string }> }> }>(opened.body)
      ?.slides?.[0]?.nodes?.map((n) => n.sourceId)
    expect(ids?.length).toBe(2)

    const r = await invoke('slides:group-elements', [{ slideIndex: 0, sourceIds: ids }])
    expect(r.status).toBe(200)
    const grouped = unwrap<{ slide?: { nodes?: Array<{ sourceId?: string }> }; groupId?: string }>(
      r.body,
    )
    expect(Array.isArray(grouped?.slide?.nodes)).toBe(true)
    expect(typeof grouped?.groupId).toBe('string')
    // The fabricated `group-<now>` never matched an element; this one must be
    // the id the grouped node actually carries.
    expect(grouped?.slide?.nodes?.[0]?.sourceId).toBe(grouped?.groupId)
  })

  it('slides:set-element-font answers the updated page (renderer feeds it to applySlide)', async () => {
    deck = await freshDeck('font')
    await invoke('slides:add-element', [
      {
        slideIndex: 0,
        kind: 'textbox',
        xPx: 10,
        yPx: 10,
        wPx: 300,
        hPx: 80,
        fitWidthPx: 1280,
        text: 'hello',
      },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const id = unwrap<{ slides?: Array<{ nodes?: Array<{ sourceId?: string }> }> }>(opened.body)
      ?.slides?.[0]?.nodes?.[0]?.sourceId

    const r = await invoke('slides:set-element-font', [
      { slideIndex: 0, sourceIds: [id], fontFamily: 'Arial', fontSizePt: 30 },
    ])
    expect(r.status).toBe(200)
    const slide = unwrap<{ nodes?: unknown[] }>(r.body)
    expect(Array.isArray(slide?.nodes)).toBe(true)
    expect(slide?.nodes?.length).toBe(1)
  })

  it('slides:find-replace reports the real match count', async () => {
    deck = await freshDeck('find-replace')
    await invoke('slides:add-element', [
      {
        slideIndex: 0,
        kind: 'textbox',
        xPx: 10,
        yPx: 10,
        wPx: 300,
        hPx: 80,
        fitWidthPx: 1280,
        text: 'alpha beta alpha',
      },
    ])
    // `{count: 0}` unconditionally was how the stub made a successful replace
    // report "0 replaced".
    const r = await invoke('slides:find-replace', [{ find: 'alpha', replace: 'gamma' }])
    expect(r.status).toBe(200)
    const res = unwrap<{ count?: number; slides?: unknown[] }>(r.body)
    expect(res?.count).toBe(2)
    expect(Array.isArray(res?.slides)).toBe(true)
  })

  it('slides:edit-text really rewrites the run text in the saved file', async () => {
    deck = await freshDeck('edit-text')
    await invoke('slides:add-element', [
      {
        slideIndex: 0,
        kind: 'textbox',
        xPx: 10,
        yPx: 10,
        wPx: 300,
        hPx: 80,
        fitWidthPx: 1280,
        text: 'before',
      },
    ])
    await invoke('slides:save', [undefined, deck, undefined])
    const opened = await invoke('slides:open-path', [deck])
    const id = unwrap<{ slides?: Array<{ nodes?: Array<{ sourceId?: string }> }> }>(opened.body)
      ?.slides?.[0]?.nodes?.[0]?.sourceId

    const r = await invoke('slides:edit-text', [
      { slideIndex: 0, sourceId: id, paragraphs: [{ runs: [{ text: 'after' }] }] },
    ])
    expect(r.status).toBe(200)
    expect(Array.isArray(unwrap<{ nodes?: unknown[] }>(r.body)?.nodes)).toBe(true)

    // Read the archive back and look for the new run text.
    const save = await invoke('slides:save', [undefined, deck, undefined])
    expect(unwrap<{ ok?: boolean }>(save.body)?.ok).toBe(true)
    const slideXml = await invoke('slides:get-render-slides', [])
    void slideXml
    const reopened = await invoke('slides:open-path', [deck])
    const text = JSON.stringify(unwrap<unknown>(reopened.body))
    expect(text).toContain('after')
    expect(text).not.toContain('before')
  })

  it('the acknowledged-no-op set stays small and declared', async () => {
    // Guards against re-growing the stub surface: the only channels allowed to
    // answer without mutating are the renderer-owned ones (OS clipboard,
    // presenter window, fullscreen), and every one must send
    // `acknowledgedOnly` so a caller can tell the difference.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(join(pkgRoot, 'src', 'slides', 'elements.ts'), 'utf8'),
    )
    const declared = [
      ...source.matchAll(/'([a-z:0-9-]+)': '[^']*(?:renderer owns|renderer-owned|no server-side|no display)/g),
    ].map((m) => m[1])
    expect(declared.sort()).toEqual([
      'slides:audience-ready',
      'slides:copy-slide',
      'slides:paste-slide',
      'slides:presenter-end',
      'slides:presenter-start',
      'slides:presenter-swap',
      'slides:repaste-slide',
      'slides:show-fullscreen',
    ])
    expect(source).toContain('acknowledgedOnly: true')
  })

  /* ── the truthy-failure trap ─────────────────────────────────────────────
   * This is the bug class the whole file exists for, so it gets its own
   * source-level guard. The renderer does
   *
   *     .then((r) => r && applySlide(current, r))
   *
   * for the `RenderSlide | null` channels, and truthiness checks for the
   * `boolean` / `number` ones. `{ok:false}` is TRUTHY, so returning it as a
   * *failure* is indistinguishable from success: the renderer replaces the
   * page with an object that has no `nodes`, or reports "notes saved" for a
   * write that never happened. That is precisely what `{ok:true}` did before.
   *
   * Every failure in `elements.ts` must therefore be `null` (or, for the one
   * channel that declares it, `{error}`). A future contributor adding
   * `{ok:false}` for an arg-validation branch would silently reintroduce the
   * original bug, so the source scan is the enforcement, not the convention.
   */
  it('no element channel answers a truthy {ok:false} failure', async () => {
    const fs = await import('node:fs')
    const source = fs.readFileSync(join(pkgRoot, 'src', 'slides', 'elements.ts'), 'utf8')
    // `apply-edit-script` is the sole exception: its contract declares
    // `{ slide } | { error: string } | null`, and the AI skill consumer reads
    // `.error` (see slides-skill.ts). Any other `error:` object would be a
    // shape the renderer cannot branch on.
    // Strip comments first: the file documents this very trap in prose
    // ("`{ok:false}` is TRUTHY…"), and matching that prose would make the
    // guard fail on its own explanation.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    const offenders = [...code.matchAll(/\{\s*ok:\s*false/g)].map((m) => m[0])
    expect(offenders).toEqual([])
    expect(source).toContain("return { error: 'slides:apply-edit-script")
  })

  it('every element-channel failure path logs, so a null is never silent', async () => {
    // `null` is the right answer for the renderer, but a bare `null` on the
    // server is indistinguishable from a legitimate no-op. Every failure
    // helper must write to stderr.
    const fs = await import('node:fs')
    const source = fs.readFileSync(join(pkgRoot, 'src', 'slides', 'elements.ts'), 'utf8')
    for (const helper of ['warnNoSession', 'warnOpFailed', 'badArgs']) {
      expect(source).toContain(`function ${helper}(`)
      expect(source).toContain('process.stderr.write')
    }
    // The arg-validation helper must actually be the one that returns null.
    expect(source).toMatch(/function badArgs\([^)]*\):\s*null/)
  })

  it('a malformed call leaves the deck untouched instead of corrupting the page', async () => {
    // End-to-end proof of the guard above: send an element channel the args it
    // rejects, and confirm the answer is `null` — not a truthy object the
    // renderer would feed to `applySlide`.
    deck = await freshDeck('bad-args')
    const r = await invoke('slides:delete-element', [{ slideIndex: 0 }])
    expect(r.status).toBe(200)
    expect(unwrap(r.body)).toBeNull()

    const bad = await invoke('slides:set-notes', [{ slideIndex: 0 }])
    expect(unwrap(bad.body)).toBe(false)
  })
})
