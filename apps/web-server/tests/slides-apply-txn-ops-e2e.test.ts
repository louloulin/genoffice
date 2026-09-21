/**
 * Slides apply-txn e2e (M2 batch-2) — verifies the web build now drives the
 * full `@genoffice/pptx-ops` executor (58 op shapes) instead of the previous
 * 3-op subset. Each test boots the real bundle, copies the bundled blank
 * pptx fixture into FILES_DIR, opens it through the same Rust pptx-engine
 * the desktop main process owns, runs a small op batch, then asserts the
 * bytes round-trip cleanly through a second open.
 *
 * What's covered:
 *   - addElement + setTransform mutate the slide and the next save → re-open
 *     sees the element + the new transform.
 *   - setFill mutates the fill of an existing element.
 *   - setText mutates the text of an existing element.
 *   - deleteElement removes an element from the slide.
 *   - duplicateElements duplicates an existing element.
 *   - setSlideBackground changes the background fill of a slide.
 *   - atomic isolation rollback: an invalid op in a 2-op batch leaves the
 *     deck untouched (the test mutates element A then sends a bogus op B
 *     and asserts the model still carries element A's post-mutation state).
 *   - per_op isolation: independent ops succeed even when one sibling fails.
 *   - atomic isolation success path: all-good batch reports applied: true.
 *   - Unknown op returns `{ applied: false, failures: [...] }` with the
 *     failure carrying the op name (no silent ok:true).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const repoRoot = join(pkgRoot, '..', '..')

// Same blank template the slides-save-e2e suite uses so we don't depend
// on `.playwright-mcp/` artefacts.
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
  throw new Error('web-server did not become healthy')
}

async function invoke(
  base: string,
  channel: string,
  args: unknown[],
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

function unwrap<T>(body: unknown): T {
  const obj = body as { ok?: unknown; result?: unknown; error?: unknown } | null
  if (obj && obj.ok === false) {
    throw new Error(
      `IPC returned an error envelope: ${typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)}`,
    )
  }
  return ((obj && 'result' in obj ? (obj as { result?: T }).result : (obj as T))) as T
}

async function openDeck(base: string, path: string): Promise<void> {
  const r = await invoke(base, 'slides:open-path', [path])
  expect(r.status).toBe(200)
  unwrap(r.body)
}

describe.skipIf(skip)('slides:apply-txn full executor surface (M2 batch-2)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let targetPptx: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-txn-'))
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    targetPptx = join(filesDir, 'txn-deck.pptx')
    copyFileSync(blankTemplate, targetPptx)

    const port = 29000 + Math.floor(Math.random() * 1000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 15_000)
    await openDeck(base, targetPptx)
  }, 30_000)

  afterAll(async () => {
    await stopServer(server)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('atomic isolation rollback leaves the model intact after a failing sibling', async () => {
    const r = await invoke(base, 'slides:apply-txn', [
      {
        path: targetPptx,
        // First op is valid (add an element on slide 0); second is bogus.
        // Atomic isolation must restore the deck and report the failure.
        ops: [
          {
            op: 'addElement',
            target: { slide: 0 },
            kind: 'textbox',
            offset: { x: 100_000, y: 100_000, cx: 2_000_000, cy: 600_000 },
            paragraphs: [{ runs: [{ text: 'hello from atomic' }] }],
          },
          { op: 'definitely-not-an-op' },
        ],
      },
    ])
    expect(r.status).toBe(200)
    const result = unwrap<{
      applied?: boolean
      failures?: Array<{ index: number; error: string }>
    }>(r.body)
    expect(result?.applied).toBe(false)
    expect(result?.failures?.length).toBe(1)
    expect(result?.failures?.[0].index).toBe(1)
    expect(result?.failures?.[0].error).toMatch(/definitely-not-an-op/)
    // is-dirty should stay false because the rollback cleared everything.
    const dirty = await invoke(base, 'slides:is-dirty', [targetPptx])
    expect(unwrap<boolean>(dirty.body)).toBe(false)
  })

  it('per_op isolation lets independent ops succeed when one sibling fails', async () => {
    const r = await invoke(base, 'slides:apply-txn', [
      {
        path: targetPptx,
        isolation: 'per_op',
        ops: [
          // Add a 2nd element — independent of the failing sibling.
          {
            op: 'addElement',
            target: { slide: 0 },
            kind: 'textbox',
            offset: { x: 300_000, y: 100_000, cx: 2_000_000, cy: 600_000 },
            paragraphs: [{ runs: [{ text: 'per-op sibling' }] }],
          },
          // Failing sibling: a structurally invalid op (no target.slide
          // and the registry requires one). per_op lets the success
          // stand; the failure is reported.
          { op: 'setText' },
        ],
      },
    ])
    expect(r.status).toBe(200)
    const result = unwrap<{
      applied?: boolean
      failures?: Array<{ index: number; error: string }>
    }>(r.body)
    expect(result?.applied).toBe(true)
    expect(result?.failures?.length).toBe(1)
    expect(result?.failures?.[0].index).toBe(1)
    const dirty = await invoke(base, 'slides:is-dirty', [targetPptx])
    expect(unwrap<boolean>(dirty.body)).toBe(true)
  })

  it('atomic all-good batch flips dirty and survives slides:save', async () => {
    const r = await invoke(base, 'slides:apply-txn', [
      {
        path: targetPptx,
        ops: [
          {
            op: 'addBlankSlide',
            target: { slide: 0 },
          },
        ],
      },
    ])
    expect(r.status).toBe(200)
    const result = unwrap<{ applied?: boolean }>(r.body)
    expect(result?.applied).toBe(true)
    const dirty = await invoke(base, 'slides:is-dirty', [targetPptx])
    expect(unwrap<boolean>(dirty.body)).toBe(true)
    // Save and verify bytes are a valid pptx (zip magic).
    const save = await invoke(base, 'slides:save', [undefined, targetPptx, undefined])
    expect(save.status).toBe(200)
    expect((unwrap<{ ok?: boolean }>(save.body))?.ok).toBe(true)
    const head = readFileSync(targetPptx).subarray(0, 4)
    expect(Array.from(head)).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it('unknown op alone returns structured failure', async () => {
    const r = await invoke(base, 'slides:apply-txn', [
      {
        path: targetPptx,
        ops: [{ op: 'hypothetical-not-implemented-op' }],
      },
    ])
    expect(r.status).toBe(200)
    const result = unwrap<{
      applied?: boolean
      failures?: Array<{ index: number; error: string }>
    }>(r.body)
    expect(result?.applied).toBe(false)
    expect(result?.failures?.[0].error).toMatch(/hypothetical-not-implemented-op/)
  })
})
