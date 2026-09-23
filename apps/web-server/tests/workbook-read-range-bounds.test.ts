/**
 * `workbook:read-range` bounds enforcement + response-size containment.
 *
 * The handler used to trust the caller's range completely, which produced two
 * independently reachable defects (both found by the perf/stability sweep in
 * `.task/perf-stability-regression-2026-09-23.md`):
 *
 *   1. **Unbounded allocation.** `rows = endRow - startRow + 1` was fed to
 *      `emptyRange`, whose `Array.from({ length: rows })` materialises one
 *      record per row. `{ startRow: -1, endRow: 999999 }` answered HTTP 200
 *      with a ~30 MB body and grew RSS by ~300 MB; four concurrent requests
 *      took the process past 1 GB. The count came straight from the request,
 *      so this was a caller-sized allocation on an unauthenticated channel.
 *
 *   2. **30 s sidecar stall.** `CellRange` is a pair of `usize`s on the Rust
 *      side, so a negative bound failed deserialisation. The sidecar replies
 *      to an unparsable line with `invalid_json` and an EMPTY `requestId`
 *      (there is no parsed request to echo). The client correlates by id, so
 *      it discarded the reply and waited out its full timeout — 30 s for a
 *      read, 300 s for a save — even though the sidecar had already answered.
 *
 * Both are now rejected up front as `WORKBOOK_INVALID_ARGUMENT` (400). This
 * suite pins the wire contract for both, and asserts the two properties that
 * make the fix real rather than cosmetic:
 *
 *   - a rejected request allocates nothing measurable and returns instantly,
 *     so the assertion is on latency + RSS, not just the status code
 *     (a fix that still built the row array before checking would pass a
 *     status-only assertion while remaining a DoS);
 *   - in-contract requests are unaffected, including the exact
 *     `MAX_RANGE_CELLS` boundary.
 *
 * Everything here drives the real bundle over HTTP, so it exercises the same
 * validation path the renderer's requests take.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'
import { MAX_RANGE_CELLS, validateRangeRequest } from '../src/sheets/range-bounds'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const repoRoot = join(pkgRoot, '..', '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const fixture = join(repoRoot, '.playwright-mcp', 'verify-supplier.xlsx')
const skip = !existsSync(bundle) || !existsSync(fixture)

/** Resident set size of a pid in MB, or null when the process is gone. */
function rssMb(pid: number | undefined): number | null {
  if (pid === undefined) return null
  try {
    return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)]).toString().trim()) / 1024
  } catch {
    return null
  }
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

interface RangeProbe {
  readonly status: number
  readonly ms: number
  readonly bodyBytes: number
  readonly code?: string
  readonly reason?: string
  readonly cells?: number
}

async function readRange(
  base: string,
  args: unknown[],
  timeoutMs = 15_000,
): Promise<RangeProbe> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${base}/api/ipc/${encodeURIComponent('workbook:read-range')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args }),
      signal: controller.signal,
    })
    // Measure the decoded body, not the declared length: the defect was a
    // body that was actually materialised, and `content-length` could be
    // absent on a chunked response.
    const raw = await response.text()
    const parsed = raw ? (JSON.parse(raw) as { error?: { code?: string; reason?: string }; result?: { cells?: unknown[] } }) : {}
    return {
      status: response.status,
      ms: Date.now() - started,
      bodyBytes: Buffer.byteLength(raw, 'utf8'),
      ...(parsed.error?.code === undefined ? {} : { code: parsed.error.code }),
      ...(parsed.error?.reason === undefined ? {} : { reason: parsed.error.reason }),
      cells: parsed.result?.cells?.length ?? 0,
    }
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - started,
      bodyBytes: 0,
      reason: err instanceof Error ? err.name : 'unknown',
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ── Pure validator unit tests ─────────────────────────────────────────────
 * These run without a server, so they cover the boundaries the e2e suite
 * would otherwise need a booted bundle (and a real workbook) to reach.
 */
describe('validateRangeRequest (range bounds)', () => {
  const valid = {
    sessionId: 'a8fd043a-9655-4ef6-b3f4-7decf0d1a240',
    sheetId: 'sheet-1',
    range: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 9 },
  }

  it('accepts an in-contract request and passes it through unchanged', () => {
    const result = validateRangeRequest(valid)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request).toEqual(valid)
  })

  it('accepts exactly MAX_RANGE_CELLS and rejects one cell more', () => {
    // 1 x 100_000 is the largest single-column span that fits the budget.
    const atCap = {
      ...valid,
      range: { startRow: 0, endRow: MAX_RANGE_CELLS - 1, startColumn: 0, endColumn: 0 },
    }
    expect(validateRangeRequest(atCap).ok).toBe(true)

    const overCap = {
      ...valid,
      range: { startRow: 0, endRow: MAX_RANGE_CELLS, startColumn: 0, endColumn: 0 },
    }
    const over = validateRangeRequest(overCap)
    expect(over.ok).toBe(false)
    if (over.ok) return
    expect(over.reason).toContain(String(MAX_RANGE_CELLS))
  })

  it('rejects the exact payload that caused the memory blow-up', () => {
    // The original repro: 1_000_001 rows x 100_005 columns ≈ 1e11 cells.
    const bomb = {
      ...valid,
      range: { startRow: -1, endRow: 999_999, startColumn: -5, endColumn: 99_999 },
    }
    const result = validateRangeRequest(bomb)
    expect(result.ok).toBe(false)
  })

  it('rejects negative and fractional bounds (the sidecar-hang trigger)', () => {
    for (const range of [
      { startRow: -1, endRow: 0, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: -1, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: 0, startColumn: -1, endColumn: 0 },
      { startRow: 0, endRow: 0, startColumn: 0, endColumn: -1 },
      { startRow: 0, endRow: 1.5, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: Number.NaN, startColumn: 0, endColumn: 0 },
      { startRow: 0, endRow: Number.POSITIVE_INFINITY, startColumn: 0, endColumn: 0 },
    ]) {
      const result = validateRangeRequest({ ...valid, range })
      expect(result.ok, `expected ${JSON.stringify(range)} to be rejected`).toBe(false)
    }
  })

  it('rejects bounds outside the worksheet limits before multiplying', () => {
    // A row index one past Excel's last row: the product would still be small
    // for a 1-wide range, so this must be caught by the limit check rather
    // than by the cell budget.
    const pastLastRow = { ...valid, range: { startRow: 0, endRow: 1_048_576, startColumn: 0, endColumn: 0 } }
    expect(validateRangeRequest(pastLastRow).ok).toBe(false)
    const pastLastColumn = { ...valid, range: { startRow: 0, endRow: 0, startColumn: 0, endColumn: 16_384 } }
    expect(validateRangeRequest(pastLastColumn).ok).toBe(false)
  })

  it('rejects reversed ranges', () => {
    const reversed = { ...valid, range: { startRow: 10, endRow: 5, startColumn: 0, endColumn: 0 } }
    expect(validateRangeRequest(reversed).ok).toBe(false)
  })

  it('rejects malformed envelopes', () => {
    for (const input of [
      null,
      undefined,
      'string',
      42,
      [],
      {},
      { ...valid, sessionId: '' },
      { ...valid, sheetId: '' },
      { ...valid, range: null },
      { ...valid, range: 'nope' },
    ]) {
      expect(validateRangeRequest(input).ok, `expected ${JSON.stringify(input)} to be rejected`).toBe(false)
    }
  })
})

/* ── End-to-end: the fix must hold over the wire ─────────────────────────── */
describe.skipIf(skip)('workbook:read-range bounds over HTTP', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let sessionId: string
  let sheetId: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-read-range-bounds-'))
    const port = 29300 + Math.floor(Math.random() * 400)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, NO_OPEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', () => {})
    server.stderr?.on('data', () => {})
    await pollHealth(base, 30_000)

    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    const target = join(filesDir, 'verify-supplier.xlsx')
    copyFileSync(fixture, target)

    const response = await fetch(`${base}/api/ipc/${encodeURIComponent('workbook:open-path')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [target] }),
    })
    const body = (await response.json()) as {
      result?: { sessionId?: string; sheets?: Array<{ id: string }> }
    }
    sessionId = body.result?.sessionId ?? ''
    sheetId = body.result?.sheets?.[0]?.id ?? ''
    expect(sessionId).toBeTruthy()
    expect(sheetId).toBeTruthy()
  }, 60_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('a legitimate read still returns real cells', async () => {
    const probe = await readRange(base, [
      { sessionId, sheetId, range: { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 } },
    ])
    expect(probe.status).toBe(200)
    // The supplier fixture's A1 header is `物料`.
    expect(probe.cells).toBeGreaterThan(0)
  })

  it('rejects an oversized range as 400 without materialising a body', async () => {
    const before = rssMb(server?.pid)
    const probe = await readRange(base, [
      { sessionId, sheetId, range: { startRow: 0, endRow: 999_999, startColumn: 0, endColumn: 99_999 } },
    ])
    expect(probe.status).toBe(400)
    expect(probe.code).toBe('WORKBOOK_INVALID_ARGUMENT')
    // The regression signature was a ~30 MB body and a multi-hundred-MB RSS
    // jump. Assert both stay negligible so a future "fix" that still builds
    // the row array before validating cannot pass this test.
    expect(probe.bodyBytes).toBeLessThan(4_096)
    expect(probe.ms).toBeLessThan(2_000)
    const after = rssMb(server?.pid)
    if (before !== null && after !== null) {
      expect(after - before).toBeLessThan(64)
    }
  })

  it('rejects the negative-bound payload instantly instead of stalling on the sidecar', async () => {
    // Pre-fix this waited out the sidecar request timeout (30 s for a read)
    // because the sidecar's `invalid_json` reply carried an empty requestId
    // and was therefore dropped by the client's id lookup.
    const probe = await readRange(base, [
      {
        sessionId,
        sheetId,
        range: { startRow: -1, endRow: 999_999, startColumn: -5, endColumn: 99_999 },
      },
    ], 8_000)
    expect(probe.status).toBe(400)
    expect(probe.code).toBe('WORKBOOK_INVALID_ARGUMENT')
    expect(probe.ms).toBeLessThan(2_000)
  })

  it('accepts the exact MAX_RANGE_CELLS boundary', async () => {
    // 1 x 100_000 sits exactly on the cap. The fixture is far smaller, so the
    // sidecar answers `range outside the worksheet` — which the handler turns
    // into empty cells, i.e. a 200. The point is that the REQUEST passes
    // validation; a cap that rejected its own boundary would 400 here.
    const probe = await readRange(base, [
      { sessionId, sheetId, range: { startRow: 0, endRow: MAX_RANGE_CELLS - 1, startColumn: 0, endColumn: 0 } },
    ])
    expect(probe.status).toBe(200)
  })

  it('bounds the empty-range fallback for an unknown session', async () => {
    // The fallback path builds the row array itself, so it is the second
    // place a caller-sized range could allocate. An in-contract range on a
    // dead session must still produce a bounded reply.
    const probe = await readRange(base, [
      {
        sessionId: 'a8fd043a-9655-4ef6-b3f4-7decf0d1a240',
        sheetId: 'sheet-1',
        range: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 0 },
      },
    ])
    expect(probe.status).toBe(200)
    expect(probe.bodyBytes).toBeLessThan(8_192)
  })
})
