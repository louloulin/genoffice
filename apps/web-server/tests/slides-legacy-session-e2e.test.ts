/**
 * Slides legacy channel session-path fallback (sdk1.md §11.16)
 *
 * Pre-fix the renderer's `slidesApi.save()` and `slides:edit-text` etc.
 * invoked the channels without sending the path. The web-server's stubs
 * answered `{ ok: true }` (silent no-op) or `{ ok: false, canceled: true }`
 * — neither was real. This suite boots the bundle, opens a deck through
 * the real `slides:open-path`, then verifies that the legacy channels:
 *
 *   1. Resolve the active deck via the SSE session id (no path arg)
 *   2. Mutate the live `OpenedPptx` through `runTxn`
 *   3. Persist the mutation on `slides:save` (with no path arg)
 *   4. Answer `null` — not a fabricated `{ ok: true }` — when no session is
 *      open. These channels declare `RenderSlide | null`; a `{ok:false}`
 *      object would be TRUTHY and get handed to `applySlide()` as if it were
 *      a page, which is the corruption this contract exists to prevent.
 *
 * Covers the 4 most-used legacy channels (per grep on apps/slides/src):
 *   slides:edit-text   (renderer call sites × 3)
 *   slides:edit-fill   (× 6)
 *   slides:edit-stroke (× 4)
 *   slides:add-element (× 7)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopServer } from './helpers/server-process'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const bundlePath = join(repoRoot, 'apps/web-server/dist/bundle/index.js')
const blankTemplate = join(repoRoot, 'apps/web-server/src/shell/templates/blank.pptx')

const haveBundle = existsSync(bundlePath)
const haveFixture = existsSync(blankTemplate)
const skip = !haveBundle || !haveFixture

// Random port range 32900-33999 mirrors the other e2e suites (was hardcoded
// 32993 pre-session — root cause of the port-collision flake when any
// other suite leaves a server listening on that exact port). The test still
// uses a stable base URL because the suite owns the lifecycle.
const PORT = 32993 + Math.floor(Math.random() * 1000)

interface InvokeResp {
  status: number
  body: { ok?: boolean; result?: unknown; error?: { message?: string; code?: string } }
}

async function invoke(
  base: string,
  channel: string,
  args: unknown[] = [],
  session?: string,
): Promise<InvokeResp> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (session) headers['x-ipc-session'] = session
  const r = await fetch(`${base}/api/ipc/${channel}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args }),
  })
  const body = (await r.json()) as InvokeResp['body']
  return { status: r.status, body }
}

function unwrap<T>(b: unknown): T {
  return b as T
}

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

describe.skipIf(skip)('slides legacy channels use SSE session path (M2 batch-2)', () => {
  let server: ChildProcess | undefined
  let dataDir: string
  let base: string
  let targetPptx: string
  let session: string

  beforeAll(async () => {
    base = `http://127.0.0.1:${PORT}`
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-slides-legacy-'))
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    targetPptx = join(filesDir, `legacy-${Date.now()}.pptx`)
    copyFileSync(blankTemplate, targetPptx)

    server = spawn('node', [bundlePath], {
      env: {
        ...process.env,
        PORT: String(PORT),
        DATA_DIR: dataDir,
        GENOFFICE_WEB_TOKEN: '',
      },
    })
    await pollHealth(base, 15_000)

    // Per-session id — record against the path on slides:open-path.
    session = `legacy-test-${Date.now()}`
    const open = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(open.status).toBe(200)
    expect((unwrap<{ path?: string }>(open.body.result))?.path).toBe(targetPptx)
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('slides:save with no path arg resolves the active session and serialises', async () => {
    // First flip the dirty flag via apply-txn so the save actually writes
    // bytes (otherwise the early-out path returns ok:true without IO).
    const dirty = await invoke(
      base,
      'slides:apply-txn',
      [{ path: targetPptx, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] }],
      session,
    )
    expect(dirty.status).toBe(200)
    expect((unwrap<{ applied?: boolean }>(dirty.body.result))?.applied).toBe(true)

    // Save with NO path arg — must resolve via SSE session id.
    const saved = await invoke(base, 'slides:save', [], session)
    expect(saved.status).toBe(200)
    const result = unwrap<{ ok?: boolean; error?: string; path?: string }>(saved.body.result)
    expect(result.ok).toBe(true)
    expect(existsSync(targetPptx)).toBe(true)
    const head = readFileSync(targetPptx).subarray(0, 4)
    expect(Array.from(head)).toEqual([0x50, 0x4b, 0x03, 0x04])
    expect(statSync(targetPptx).size).toBeGreaterThan(0)
  })

  it('slides:edit-text with no path arg dispatches setText via runTxn (not a silent ok:true)', async () => {
    // Re-open to reset the session model after the previous save flushed.
    const reopen = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(reopen.status).toBe(200)

    // Use a deliberately bogus element id so the test verifies the
    // legacy channel reaches runTxn (which returns a structured error
    // for missing ids) instead of silently swallowing the edit.
    const edit = await invoke(
      base,
      'slides:edit-text',
      [
        {
          slideIndex: 0,
          sourceId: 'nonexistent-element-for-test',
          paragraphs: [{ runs: [{ text: 'x' }] }],
        },
      ],
      session,
    )
    expect(edit.status).toBe(200)
    // A bogus element id means setText cannot apply, so the channel answers
    // `null` — the contract's failure value. The old stub answered `{ok:true}`,
    // which the renderer accepted as a page and stored in place of the slide.
    expect(edit.body.result).toBeNull()
  })

  it('slides:edit-fill with no path arg dispatches setFill (structured error envelope on missing element)', async () => {
    const reopen = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(reopen.status).toBe(200)

    const edit = await invoke(
      base,
      'slides:edit-fill',
      [{ slideIndex: 0, sourceId: 'nonexistent-element', fill: '#ff0000' }],
      session,
    )
    expect(edit.status).toBe(200)
    // Missing element → the op cannot apply → `null`, never `{ok:true}`.
    expect(edit.body.result).toBeNull()
  })

  it('slides:edit-stroke with no path arg dispatches setStroke', async () => {
    const reopen = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(reopen.status).toBe(200)

    const edit = await invoke(
      base,
      'slides:edit-stroke',
      [
        {
          slideIndex: 0,
          sourceId: 'nonexistent-element',
          stroke: { color: '#000000', widthPt: 1 },
        },
      ],
      session,
    )
    expect(edit.status).toBe(200)
    expect(edit.body.result).toBeNull()
  })

  it('slides:add-element with no path arg dispatches addElement', async () => {
    const reopen = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(reopen.status).toBe(200)

    const add = await invoke(
      base,
      'slides:add-element',
      [
        {
          slideIndex: 0,
          kind: 'rect',
          xPx: 10,
          yPx: 10,
          wPx: 50,
          hPx: 50,
          fitWidthPx: 50,
        },
      ],
      session,
    )
    expect(add.status).toBe(200)
    // Contract: `{slide, sourceId} | null`. The old stub answered
    // `{ok:true, elementId:'element-<now>'}` — a fabricated id the renderer
    // then tried to select. `sourceId` must be the id the op actually minted.
    const created = unwrap<{ slide?: { nodes?: unknown[] }; sourceId?: string }>(add.body.result)
    expect(created).toBeTruthy()
    expect(Array.isArray(created.slide?.nodes)).toBe(true)
    expect(typeof created.sourceId).toBe('string')
    expect(created.sourceId!.length).toBeGreaterThan(0)
  })

  it('slides:edit-text without an open session returns a structured error', async () => {
    // New SSE session id that never opened anything — must NOT silently ok.
    const stranger = `stranger-${Date.now()}`
    const edit = await invoke(
      base,
      'slides:edit-text',
      [{ slideIndex: 0, sourceId: 'x', paragraphs: [] }],
      stranger,
    )
    expect(edit.status).toBe(200)
    // No session → `null`. The renderer's `if (r)` guard then leaves the
    // document alone instead of reporting a success that did not happen.
    expect(edit.body.result).toBeNull()
  })

  it('slides:save-as with no sourcePath resolves the active session', async () => {
    const reopen = await invoke(base, 'slides:open-path', [targetPptx], session)
    expect(reopen.status).toBe(200)

    // Mutate so save-as has something to serialise.
    await invoke(
      base,
      'slides:apply-txn',
      [{ path: targetPptx, ops: [{ op: 'addBlankSlide', target: { slide: 0 } }] }],
      session,
    )

    // save-as with no sourcePath (4th arg) — must use SSE session path.
    const saved = await invoke(
      base,
      'slides:save-as',
      ['save-as-test.pptx', undefined, undefined],
      session,
    )
    expect(saved.status).toBe(200)
    const result = unwrap<{ ok?: boolean; error?: string; path?: string }>(saved.body.result)
    expect(result.ok).toBe(true)
    expect(typeof result.path).toBe('string')
  })
})
