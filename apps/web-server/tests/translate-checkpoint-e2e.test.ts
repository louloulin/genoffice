/**
 * Translation-session checkpoint store (A48).
 *
 * `translateDocument` can resume a cancelled or interrupted run from a
 * `TranslateCheckpoint` adapter (`load(unitId)` / `save(unitId, result)`, A46).
 * The renderer that drives the pipeline cannot implement that adapter itself —
 * inside the Dataflare embed there is no durable origin storage — so the
 * web-server exposes one over HTTP, scoped to a translation session:
 *
 *   POST /api/ai/translate/checkpoint   — save one unit (or a batch)
 *   GET  /api/ai/translate/checkpoint   — read every unit of a session
 *
 * These pin the three properties the resume contract depends on: a settled unit
 * comes back verbatim, sessions do not bleed into one another, and the store
 * outlives the process (so a restart resumes rather than re-billing).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

const BUNDLE = join(__dirname, '..', 'dist', 'bundle', 'index.js')

function pickPort(): number {
  return 26000 + Math.floor(Math.random() * 3000)
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

function boot(dataDir: string, port: number): ChildProcess {
  const child = spawn(process.execPath, [BUNDLE], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      GENOFFICE_WEB_DATA_DIR: dataDir,
      NO_OPEN: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', () => {})
  child.stderr?.on('data', () => {})
  return child
}

function translated(unitId: string, translatedText: string) {
  return { unitId, sourceText: `src-${unitId}`, translatedText, status: 'translated' as const }
}

async function save(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/ai/translate/checkpoint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function load(base: string, sessionId: string): Promise<{ units: Array<{ unitId: string; translatedText?: string }> }> {
  const res = await fetch(
    `${base}/api/ai/translate/checkpoint?sessionId=${encodeURIComponent(sessionId)}`,
  )
  expect(res.status).toBe(200)
  return (await res.json()) as { units: Array<{ unitId: string; translatedText?: string }> }
}

describe('translation-session checkpoint store (A48)', () => {
  let server: ChildProcess | undefined
  let base: string
  const dataDir = mkdtempSync(join(tmpdir(), 'genoffice-checkpoint-'))

  beforeAll(async () => {
    const port = pickPort()
    base = `http://127.0.0.1:${port}`
    server = boot(dataDir, port)
    await waitForHealth(base)
  }, 90_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('saves a settled unit and reads it back for the same session', async () => {
    const res = await save(base, {
      sessionId: 'doc-1:zh-CN',
      unitId: 'u1',
      result: translated('u1', '你好'),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { saved: number }).toMatchObject({ ok: true, saved: 1 })

    const body = await load(base, 'doc-1:zh-CN')
    expect(body.units.map((u) => u.unitId)).toEqual(['u1'])
    // Verbatim: the renderer reuses this result without touching the provider,
    // so a field lost here is a unit it would have to pay for twice.
    expect(body.units[0]!.translatedText).toBe('你好')
  })

  it('accepts a whole run of units in one call', async () => {
    const res = await save(base, {
      sessionId: 'doc-batch',
      units: [
        { unitId: 'a', result: translated('a', '甲') },
        { unitId: 'b', result: translated('b', '乙') },
      ],
    })
    expect(((await res.json()) as { saved: number }).saved).toBe(2)

    const body = await load(base, 'doc-batch')
    expect(body.units.map((u) => u.unitId).sort()).toEqual(['a', 'b'])
  })

  it('keeps one session from reading another', async () => {
    expect((await load(base, 'doc-never-written')).units).toEqual([])
  })

  it('rejects a missing or malformed session id', async () => {
    expect((await save(base, { unitId: 'u', result: translated('u', 'x') })).status).toBe(400)
    expect((await save(base, { sessionId: 'ok', unitId: 'u' })).status).toBe(400)
    const bad = await fetch(`${base}/api/ai/translate/checkpoint?sessionId=bad%2Fid`)
    expect(bad.status).toBe(400)
  })

  it('refuses to store a result the core could not resume from', async () => {
    const res = await save(base, {
      sessionId: 'doc-1:zh-CN',
      unitId: 'u2',
      result: { unitId: 'u2', sourceText: 'x', status: 'failed', errorMessage: 'boom' },
    })
    expect(res.status).toBe(400)
    expect((await load(base, 'doc-1:zh-CN')).units.map((u) => u.unitId)).toEqual(['u1'])
  })

  it('survives a restart — the settled units are persisted, not just in memory', async () => {
    // A dedicated DATA_DIR so this test owns both server lifetimes.
    const dir = mkdtempSync(join(tmpdir(), 'genoffice-checkpoint-restart-'))
    const first = pickPort()
    const s1 = boot(dir, first)
    try {
      await waitForHealth(`http://127.0.0.1:${first}`)
      await save(`http://127.0.0.1:${first}`, {
        sessionId: 'resume',
        unitId: 'r1',
        result: translated('r1', '甲'),
      })
    } finally {
      // SIGTERM flushes the coalesced write; the next boot reads it back.
      await stopServer(s1)
    }

    const second = pickPort()
    const s2 = boot(dir, second)
    try {
      await waitForHealth(`http://127.0.0.1:${second}`)
      const body = await load(`http://127.0.0.1:${second}`, 'resume')
      expect(body.units.map((u) => u.unitId)).toEqual(['r1'])
      expect(body.units[0]!.translatedText).toBe('甲')
    } finally {
      await stopServer(s2, dir)
    }
  }, 120_000)
})
