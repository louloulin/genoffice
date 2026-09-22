/**
 * Slides hash-based id stability at the web-server boundary (sdk1 §A.5 #7
 * follow-up close — §11.82 engine feature, §11.84 web-server opt-in).
 *
 * What this file proves:
 *
 *   1. With useHashBasedIds: true (default in web-server slides:open-path
 *      after §11.84), the same deck bytes always produce the same element
 *      ids — even after a save + re-open round-trip and even after
 *      appending a new shape to an existing slide. The previous counter
 *      scheme (default) shifted every later id by one when the user
 *      inserted a new shape between two existing ones, so the renderer's
 *      stale selections pointed at nothing and every id-addressed channel
 *      answered `null` for elements the user could still see.
 *
 *   2. The hash ids match the engine-side contract: prefix from the
 *      element kind (`sp_`, `pic_`, etc.) + 10 hex chars.
 *
 *   3. The savePptxToFile round-trip preserves the ids byte-for-byte
 *      (no internal re-numbering on save).
 *
 *   4. The web-server open path applies useHashBasedIds: true by default
 *      — verified by inspecting the deck after open-path, not by reading
 *      server config (server internals stay private).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTransportValue } from '../src/common/codec'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const fixture = join(repoRoot, 'packages/pptx-engine/tests/fixtures/01_standard_business.pptx')

const haveBundle = existsSync(bundle)
const haveFixture = existsSync(fixture)
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

function unwrapResult<T = Record<string, unknown>>(body: unknown): T | undefined {
  const b = body as { result?: T }
  return b?.result
}

describe.skipIf(skip)('slides:open-path uses hash-based stable ids by default (sdk1 §11.84)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let fileId: string
  let filePath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'slides-hash-id-'))
    const filesDir = join(dataDir, 'files')
    const uploadsDir = join(filesDir, 'uploads')
    require('node:fs').mkdirSync(uploadsDir, { recursive: true })
    const port = 19300 + Math.floor(Math.random() * 200)

    server = spawn('node', [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        FILES_DIR: filesDir,
        GENOFFICE_JWT_SECRET: 'hash-id-test-secret',
        GENOFFICE_JWT_ALG: 'HS256',
        WEB_TOKEN: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    base = `http://127.0.0.1:${port}`
    await pollHealth(base, 15_000)

    // Drop the fixture into FILES_DIR under a stable id and use that path.
    fileId = 'fixture-standard-business'
    filePath = join(filesDir, `${fileId}.pptx`)
    copyFileSync(fixture, filePath)
  }, 30_000)

  afterAll(() => {
    if (server && !server.killed) server.kill('SIGTERM')
    if (dataDir) rmSync(dataDir, { recursive: true, force: true })
  })

  it('first open-path yields hash-shaped ids (prefix + 10 hex)', async () => {
    const r = await invoke(base, 'slides:open-path', [filePath, 800])
    expect(r.status).toBe(200)
    const result = unwrapResult<{ slides?: Array<{ nodes?: Array<{ sourceId: string }> }> }>(r.body)
    expect(result).toBeDefined()
    const nodes = result?.slides?.[0]?.nodes ?? []
    expect(nodes.length).toBeGreaterThan(0)
    // §11.82 engine contract: id = `<prefix>_<10 hex>` for any prefix.
    // Both shapes on slide 1 of the standard_business fixture are <p:sp>
    // so they all start with `sp_` and the suffix is 10 hex chars.
    for (const n of nodes) {
      expect(n.sourceId).toMatch(/^sp_[0-9a-f]{10}$/)
    }
    // Persist for downstream assertions.
    const beforeIds = nodes.map((n) => n.sourceId)
    ;(globalThis as Record<string, unknown>).__beforeIds = beforeIds
  })

  it('second open-path on the same bytes yields the same hash ids', async () => {
    // The previous counter scheme would re-number on every parse. The
    // hash scheme is parse-stable.
    const beforeIds = (globalThis as Record<string, unknown>).__beforeIds as string[]
    const r = await invoke(base, 'slides:open-path', [filePath, 800])
    expect(r.status).toBe(200)
    const result = unwrapResult<{ slides?: Array<{ nodes?: Array<{ sourceId: string }> }> }>(r.body)
    const afterIds = (result?.slides?.[0]?.nodes ?? []).map((n) => n.sourceId)
    expect(afterIds).toEqual(beforeIds)
  })

  it('appending a new shape (addElement) keeps the existing ids stable', async () => {
    // Engine semantics: `addElement` appends to slide.elements (no
    // insertIndex honoured). The hash scheme guarantees the original
    // shapes keep their pre-existing ids — the counter scheme would
    // have shifted every pre-existing id when the element list grew.
    const beforeIds = (globalThis as Record<string, unknown>).__beforeIds as string[]

    const add = await invoke(base, 'slides:apply-txn', [
      {
        path: filePath,
        ops: [
          {
            op: 'addElement',
            target: { slide: 0 },
            kind: 'rect',
            offset: { x: 100_000, y: 100_000, cx: 200_000, cy: 200_000 },
            fill: '#FF0000',
          },
        ],
      },
    ])
    // eslint-disable-next-line no-console
    console.log('apply-txn result:', JSON.stringify(add.body, null, 2))
    expect(add.status).toBe(200)

    const r = await invoke(base, 'slides:open-path', [filePath, 800])
    expect(r.status).toBe(200)
    const result = unwrapResult<{ slides?: Array<{ nodes?: Array<{ sourceId: string }> }> }>(r.body)
    const allIds = (result?.slides?.[0]?.nodes ?? []).map((n) => n.sourceId)
    // The new shape is appended at the end of slide.elements (engine
    // semantics for addElement). The hash scheme guarantees the original
    // shapes keep their pre-existing ids — the counter scheme would have
    // shifted `sp_6df7fb6742 → sp_<n>` when `sp_e5bf247b8c` got bumped.
    expect(allIds.length).toBe(beforeIds.length + 1)
    expect(allIds.slice(0, beforeIds.length)).toEqual(beforeIds)
    // The new shape gets a fresh `spnew_<counter>_<timestamp>` id (engine
    // contract for elements created mid-session, not parsed from bytes).
    expect(allIds[beforeIds.length]).toMatch(/^spnew_[0-9a-z_]+$/)
    // And the id is distinct from every pre-existing id.
    for (const id of beforeIds) {
      expect(allIds[beforeIds.length]).not.toBe(id)
    }
  })

  it('after save + re-open from disk, the appended layout is preserved', async () => {
    // savePptxToFile round-trips through the OOXML bytes — there is no
    // re-numbering on save. A subsequent re-open should yield the same
    // shape ids in the same order.
    const beforeIds = (globalThis as Record<string, unknown>).__beforeIds as string[]

    const save = await invoke(base, 'slides:save', [{ path: filePath }])
    expect(save.status).toBe(200)

    const r = await invoke(base, 'slides:open-path', [filePath, 800])
    expect(r.status).toBe(200)
    const result = unwrapResult<{ slides?: Array<{ nodes?: Array<{ sourceId: string }> }> }>(r.body)
    const ids = (result?.slides?.[0]?.nodes ?? []).map((n) => n.sourceId)
    expect(ids.length).toBe(beforeIds.length + 1)
    // Original shapes keep their original ids through the savePptxToFile
    // round-trip (the engine writes the in-memory model as OOXML bytes
    // and re-parses on re-open). The counter scheme would have shifted
    // them; the hash scheme keeps every fragment-stable.
    expect(ids.slice(0, beforeIds.length)).toEqual(beforeIds)
  })
})
