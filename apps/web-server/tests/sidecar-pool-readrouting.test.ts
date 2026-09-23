/**
 * Sidecar pool read-routing regression (sdk1 §11.87 follow-up).
 *
 * The §11.87 pool hashes each request to a worker and the xlsx-sidecar's
 * session map is per-process — a session opened on worker A is only
 * readable on worker A. The first cut routed `readRange({sessionId})` by
 * `hash(sessionId)`, but `workbook:open-path` mints the sessionId with
 * `sheet-${Date.now()}` and never bound it to the source path. The two
 * hashes collided ~1/N of the time, so the very first read after an open
 * returned empty cells and the `workbook-save-e2e` suite flaked
 * intermittently (4/5 fail in isolation).
 *
 * The fix threads the registry's sourcePath into the sidecar call so
 * the pool routes by path (same key as `open(path)`). This suite pins
 * the contract end-to-end: open N distinct workbooks, hit
 * `workbook:read-range` on each immediately, every call must return
 * the header cells. A regression to sessionId-only routing would
 * surface here as `~N × (N-1)/N` empty reads, well above the 0 we
 * assert.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stopServer } from './helpers/server-process'

async function ipc(base: string, channel: string, args: unknown[]): Promise<{ status: number; body: { ok?: boolean; result?: Record<string, unknown> } }> {
  const res = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: res.status, body: (await res.json()) }
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch { /* keep polling */ }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('web-server did not become healthy')
}

describe('sidecar pool read-routing (§11.87 fix)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let bundle: string

  beforeAll(async () => {
    bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
    if (!existsSync(bundle)) throw new Error(`bundle missing: ${bundle}`)
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-pool-routing-'))
    const port = 29600 + Math.floor(Math.random() * 500)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: dataDir,
        GENOFFICE_WEB_DATA_DIR: dataDir,
        // Force the pool size that makes the sessionId-vs-path hash
        // mismatch most likely (the bug was probabilistic — 4/5 in
        // N=4 — so we set N=4 explicitly here).
        SHEETS_SIDECAR_POOL_SIZE: '4',
        NO_OPEN: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', () => {})
    server.stderr?.on('data', () => {})
    await waitForHealth(base)

    // Seed the FILES_DIR with the supplier fixture the renderer already
    // round-trips through the sidecar. Multiple copies under distinct
    // filenames give every workbook its own path-hash so the routing
    // correctness check is meaningful (identical filenames would all
    // land on the same worker regardless of the fix).
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const fixture = join(__dirname, '..', '..', '..', '.playwright-mcp', 'verify-supplier.xlsx')
    if (!existsSync(fixture)) {
      throw new Error(`fixture missing: ${fixture}`)
    }
    // Stash a few copies for the test to open. The test copies them
    // again under distinct names so the path keys differ.
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('a workbook opened and immediately read returns the header cells (every worker)', async () => {
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const fixture = join(__dirname, '..', '..', '..', '.playwright-mcp', 'verify-supplier.xlsx')

    // Run several rounds so each round exercises the full pool routing
    // surface. Eight files × three rounds = 24 open+read pairs; with the
    // buggy sessionId-only routing ~6 of them returned 0 cells.
    const ROUNDS = 3
    const FILES_PER_ROUND = 8
    let failures = 0
    for (let r = 0; r < ROUNDS; r++) {
      const paths: string[] = []
      for (let i = 0; i < FILES_PER_ROUND; i++) {
        const target = join(filesDir, `book-r${r}-${i}.xlsx`)
        copyFileSync(fixture, target)
        paths.push(target)
      }
      const opens = await Promise.all(
        paths.map((p) => ipc(base, 'workbook:open-path', [p])),
      )
      const reads = await Promise.all(
        opens.map((open) => {
          const result = open.body.result ?? {}
          return ipc(base, 'workbook:read-range', [{
            sessionId: result.sessionId as string,
            sheetId: (result.sheets as Array<{ id: string }> | undefined)?.[0]?.id ?? 'sheet-1',
            range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
          }])
        }),
      )
      for (const rr of reads) {
        const cells = (rr.body.result?.cells as unknown[] | undefined)?.length ?? 0
        if (cells === 0) failures++
      }
    }
    expect(failures).toBe(0)
  })
})
