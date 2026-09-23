/**
 * Slides master-edit e2e (sdk1 §E.8 P1 #8).
 *
 * These channels used to answer `{ ok: true }` while touching nothing. The
 * renderer treats any truthy return as the re-rendered page and overwrites
 * its master slide state with the stub object — the master view went blank
 * on every edit, and downstream selections/edits compounded from corrupt
 * state. We never noticed because nothing on the web side was wired to a
 * real op pipeline.
 *
 * The web build now drives the same `@genoffice/pptx-ops` executor the outer
 * deck uses, seeded with the master part (`runTxn({ parts: Map([[partPath,
 * slide]]) })`). The executor's `flushTouchedParts` re-serialises the seeded
 * part to `archive.entries` and then re-materialises every deck slide so the
 * inheritance chain picks up the chrome changes — the desktop relies on the
 * same lifecycle (sdk1 §E.8 commentary).
 *
 * What's covered:
 *   - master-enter returns at least one part item with a renderable slide
 *   - master-open binds the chosen part and returns its render
 *   - master-edit-text changes the text and survives save + reopen
 *   - master-edit-fill sets a hex fill and survives save + reopen
 *   - master-edit-stroke sets a stroke and survives save + reopen
 *   - master-delete-element removes the element and survives save + reopen
 *   - master-close returns the full deck render array
 *   - the channels answer null (not `{ ok: true }`) when no edit target is
 *     bound, so the renderer's `if (r)` guard leaves the document alone
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import JSZip from 'jszip'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'
import { openPptx, parseMasterPart } from '@genoffice/pptx-engine'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const fxRoot = join(pkgRoot, '..', '..', 'packages', 'pptx-engine', 'tests', 'fixtures')
const standardFixture = join(fxRoot, '01_standard_business.pptx')
const skip = !existsSync(bundle) || !existsSync(standardFixture)

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

describe.skipIf(skip)('slides master-edit channels really mutate the deck', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let deck: string

  const invokeAs = async (
    session: string,
    channel: string,
    args: unknown[],
  ) => {
    const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ipc-session': session },
      body: JSON.stringify({ args: args.map((a) => encodeTransportValue(a)) }),
    })
    const text = await response.text()
    return { status: response.status, body: text ? JSON.parse(text) : null }
  }
  const invoke = (channel: string, args: unknown[]) =>
    invokeAs('master-e2e', channel, args)
  const unwrap = <T = Record<string, unknown>>(body: unknown): T | undefined =>
    (body as { result?: T })?.result

  /** Open `path` and bind it as the master-e2e session's current deck. */
  const open = async (path: string): Promise<void> => {
    const r = await invoke('slides:open-path', [path, 1280])
    expect(r.status).toBe(200)
  }

  /** Walk every render tree node and gather the text content from text/shape
   *  nodes — the master slide has placeholder text we can mutate and verify. */
  const collectText = (node: unknown): string => {
    if (!node || typeof node !== 'object') return ''
    const n = node as {
      type?: string
      text?: { runs?: Array<{ text?: string }> }
      children?: unknown[]
    }
    let s = ''
    if (n.type === 'text' && n.text?.runs) {
      for (const r of n.text.runs) if (r.text) s += r.text
    }
    if (Array.isArray(n.children)) {
      for (const c of n.children) s += collectText(c)
    }
    return s
  }

  const firstTextEl = (
    slide: unknown,
  ): { id: string; text: string } | null => {
    const walk = (n: unknown): { id: string; text: string } | null => {
      if (!n || typeof n !== 'object') return null
      const x = n as { type?: string; id?: string; sourceId?: string; text?: unknown; children?: unknown[] }
      // Layout placeholders carry `type: 'text'` even when their text body is
      // empty; `setText` is happy to populate them, so accept any text-typed
      // node regardless of current content.
      if (x.type === 'text' || x.type === 'shape') {
        const id = x.sourceId ?? x.id
        if (id) return { id, text: collectText(x) }
      }
      if (Array.isArray(x.children)) for (const c of x.children) {
        const r = walk(c)
        if (r) return r
      }
      return null
    }
    const s = slide as { nodes?: unknown[] }
    for (const n of s.nodes ?? []) {
      const r = walk(n)
      if (r) return r
    }
    return null
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-master-'))
    const port = 36000 + Math.floor(Math.random() * 1000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 20_000)

    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    deck = join(filesDir, `master-${Date.now()}.pptx`)
    copyFileSync(standardFixture, deck)
    // Bind the deck to the master-e2e session before any test runs.
    // Tests that match `-t <name>` may not run the first suite case, so
    // every case must see a live session without depending on order.
    await open(deck)
  })

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('master-enter returns master + layout items, each with a real render', async () => {
    const r = await invoke('slides:master-enter', [1280])
    expect(r.status).toBe(200)
    const result = unwrap<{ items?: Array<{ partPath: string; kind: string; name: string; slide: unknown }> }>(r.body)
    expect(result?.items?.length).toBeGreaterThan(1)
    const master = result!.items!.find((it) => it.kind === 'master')
    const layout = result!.items!.find((it) => it.kind === 'layout')
    expect(master).toBeDefined()
    expect(layout).toBeDefined()
    // Master part path matches the master XML inside the zip
    expect(master!.partPath).toMatch(/slideMaster\d+\.xml$/)
    // Layout part path matches a layout XML
    expect(layout!.partPath).toMatch(/slideLayout\d+\.xml$/)
    // Both parts have render trees — slide property is an object with nodes,
    // not a stubbed `{ ok: true }` truthy value.
    for (const it of [master!, layout!]) {
      const slide = it.slide as { nodes?: unknown[] }
      expect(Array.isArray(slide?.nodes)).toBe(true)
      expect(slide!.nodes!.length).toBeGreaterThan(0)
    }
  })

  it('master-open binds the chosen part and returns its render', async () => {
    const list = unwrap<{ items?: Array<{ partPath: string }> }>(
      (await invoke('slides:master-enter', [1280])).body,
    )
    const layout = list?.items?.find((it) => it.partPath.includes('slideLayout'))
    expect(layout).toBeDefined()
    const r = await invoke('slides:master-open', [layout!.partPath])
    expect(r.status).toBe(200)
    const slide = unwrap<{ nodes?: unknown[] }>(r.body)
    expect(slide).toBeTruthy()
    expect(Array.isArray(slide?.nodes)).toBe(true)
  })

  it('master-edit-text mutates the part and survives save + reopen', async () => {
    const list = unwrap<{ items?: Array<{ partPath: string; kind?: string; slide: unknown }> }>(
      (await invoke('slides:master-enter', [1280])).body,
    )
    // Layouts carry text placeholders; masters in this fixture are shape-only.
    const target = list?.items?.find((it) => it.kind === 'layout') ?? list?.items?.[0]
    expect(target).toBeDefined()
    await invoke('slides:master-open', [target!.partPath])
    const el = firstTextEl(target!.slide)
    expect(el).toBeTruthy()
    const stamp = `MASTER-EDIT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const r = await invoke('slides:master-edit-text', [
      {
        sourceId: el!.id,
        paragraphs: [
          {
            runs: [{ text: stamp }],
          },
        ],
      },
    ])
    expect(r.status).toBe(200)
    // The authoritative check: the part bytes on disk after save+reopen
    // carry the new text. The render is re-materialised from those bytes on
    // next parse, so the bytes are what survives the round-trip — the
    // in-memory RenderSlide is a transient view and doesn't drive persistence.
    expect(unwrap(r.body)).toBeTruthy()

    await invoke('slides:save', [undefined, deck, undefined])
    const fresh = await openPptx(readFileSync(deck))
    const partXml = fresh.archive.readText(target!.partPath)
    expect(partXml).toContain(stamp)
    // And the part still parses (re-master-edit cycles reuse the same parse).
    const reparsed = parseMasterPart(fresh.archive, target!.partPath)
    expect(reparsed).toBeTruthy()
    const elAfter = reparsed?.elements.find((e) => e.id === el!.id)
    expect(elAfter?.text?.paragraphs.some((p: { runs: Array<{ text: string }> }) =>
      p.runs.some((r) => r.text === stamp),
    )).toBe(true)
  })

  it('master-edit-fill sets a hex fill and survives save + reopen', async () => {
    const list = unwrap<{ items?: Array<{ partPath: string; slide: unknown }> }>(
      (await invoke('slides:master-enter', [1280])).body,
    )
    const first = list?.items?.[0]
    expect(first).toBeDefined()
    await invoke('slides:master-open', [first!.partPath])
    // Pick the first shape (text-or-shape) that supports fill.
    const slide = unwrap<{ nodes?: unknown[] }>((await invoke('slides:master-open', [first!.partPath])).body)
    const fillEl = firstFillableEl(slide)
    expect(fillEl).toBeTruthy()
    const stamp = '#aabb33'
    const r = await invoke('slides:master-edit-fill', [
      { sourceId: fillEl!.id, fill: stamp },
    ])
    expect(r.status).toBe(200)
    expect(r.body?.result).toBeTruthy()
    // The op's fill spec round-trips through the executor into the part bytes.
    await invoke('slides:save', [undefined, deck, undefined])
    const fresh = await openPptx(readFileSync(deck))
    const masterXml = fresh.archive.readText(first!.partPath)
    expect(masterXml).toMatch(/aabb33/i)
  })

  it('master-edit-stroke sets a stroke and survives save + reopen', async () => {
    const list = unwrap<{ items?: Array<{ partPath: string; slide: unknown }> }>(
      (await invoke('slides:master-enter', [1280])).body,
    )
    const first = list?.items?.[0]
    expect(first).toBeDefined()
    await invoke('slides:master-open', [first!.partPath])
    const slide = unwrap<{ nodes?: unknown[] }>((await invoke('slides:master-open', [first!.partPath])).body)
    const el = firstFillableEl(slide)
    expect(el).toBeTruthy()
    const r = await invoke('slides:master-edit-stroke', [
      { sourceId: el!.id, stroke: { color: '#3344aa', widthPt: 2 } },
    ])
    expect(r.status).toBe(200)
    expect(r.body?.result).toBeTruthy()
    await invoke('slides:save', [undefined, deck, undefined])
    const fresh = await openPptx(readFileSync(deck))
    const masterXml = fresh.archive.readText(first!.partPath)
    expect(masterXml).toMatch(/3344aa/i)
  })

  it('master-delete-element removes the element and survives save + reopen', async () => {
    const list = unwrap<{ items?: Array<{ partPath: string; slide: unknown }> }>(
      (await invoke('slides:master-enter', [1280])).body,
    )
    const first = list?.items?.[0]
    expect(first).toBeDefined()
    await invoke('slides:master-open', [first!.partPath])
    const slide = unwrap<{ nodes?: unknown[] }>((await invoke('slides:master-open', [first!.partPath])).body)
    const el = firstTextEl(slide) ?? firstFillableEl(slide)
    expect(el).toBeTruthy()
    // openPptx returns OpenedPptx directly — `deck.slides`, not `.opened.deck.slides`.
    const beforeFresh = await openPptx(readFileSync(deck))
    const beforeCount = countNodes(beforeFresh.deck.slides[0] as unknown as { elements?: unknown[] })
    const r = await invoke('slides:master-delete-element', [{ sourceId: el!.id }])
    expect(r.status).toBe(200)
    expect(r.body?.result).toBeTruthy()
    await invoke('slides:save', [undefined, deck, undefined])
    const afterFresh = await openPptx(readFileSync(deck))
    const afterCount = countNodes(afterFresh.deck.slides[0] as unknown as { elements?: unknown[] })
    // The deck-level slide count never changes (master/layout edits don't
    // touch slide parts), but the master part bytes should now lack the
    // deleted element's id.
    const masterXml = afterFresh.archive.readText(first!.partPath)
    expect(masterXml).not.toContain(el!.id)
    expect(afterCount).toBe(beforeCount) // deck slide is unchanged
  })

  it('master-close returns the full re-rendered deck', async () => {
    const r = await invoke('slides:master-close', [])
    expect(r.status).toBe(200)
    const slides = unwrap<Array<{ nodes?: unknown[] }>>(r.body)
    expect(Array.isArray(slides)).toBe(true)
    expect(slides!.length).toBeGreaterThan(0)
    for (const s of slides!) expect(Array.isArray(s.nodes)).toBe(true)
  })

  it('master-edit-* with no edit target answers null, not a stubbed success', async () => {
    // Fresh session that never called master-open / master-enter.
    const r = await invokeAs('never-entered', 'slides:master-edit-text', [
      { sourceId: 'sp_does_not_matter', paragraphs: [{ runs: [{ text: 'x' }] }] },
    ])
    expect(r.status).toBe(200)
    expect(r.body?.result).toBeNull()

    const r2 = await invokeAs('never-entered', 'slides:master-delete-element', [
      { sourceId: 'sp_whatever' },
    ])
    expect(r2.status).toBe(200)
    expect(r2.body?.result).toBeNull()
  })

  /* Walks the slide's render tree and returns the first element that supports
   * fill (text or shape with no alt-content group parent in the chain we care
   * about). Matches the engine's `setFill` `types: ['text', 'shape']` filter
   * so we don't pick an element the op would reject. */
  function firstFillableEl(slide: unknown): { id: string } | null {
    const walk = (n: unknown): { id: string } | null => {
      if (!n || typeof n !== 'object') return null
      const x = n as { type?: string; id?: string; sourceId?: string; children?: unknown[] }
      if (x.type === 'text' || x.type === 'shape') {
        const id = x.sourceId ?? x.id
        if (id) return { id }
      }
      if (Array.isArray(x.children)) for (const c of x.children) {
        const r = walk(c)
        if (r) return r
      }
      return null
    }
    const s = slide as { nodes?: unknown[] }
    for (const n of s.nodes ?? []) {
      const r = walk(n)
      if (r) return r
    }
    return null
  }

  function countNodes(slide: { elements?: unknown[] }): number {
    let count = 0
    const walk = (els: unknown[] | undefined): void => {
      for (const el of els ?? []) {
        if (!el || typeof el !== 'object') continue
        const e = el as { type?: string; children?: unknown[]; elements?: unknown[] }
        count++
        if (Array.isArray(e.children)) walk(e.children)
      }
    }
    walk(slide.elements)
    return count
  }
})
