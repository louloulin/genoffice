/**
 * Workbook error code unification (sdk1 §11.59).
 *
 * The renderer's error-recovery branches want workbook-specific signals,
 * not the generic `INVALID_ARGUMENT` / `NOT_FOUND` / `CORRUPT` codes every
 * web-server handler shares. A `workbook:save` failure caused by an
 * unknown sessionId, for example, should be distinguishable from a
 * `files:read` failure caused by a missing path — both are 404-ish but the
 * recovery path differs (reopen file vs. prompt "session expired, re-open
 * the document?").
 *
 * What this file covers:
 *   - `workbook:open-path` against a missing file → `WORKBOOK_NOT_FOUND` (404)
 *   - `workbook:open-path` against a `.xls` fixture → `WORKBOOK_CORRUPT` (422)
 *   - `workbook:open-path` against random bytes → `WORKBOOK_CORRUPT` (422)
 *   - `workbook:open-for-merge` with too many sources →
 *     `WORKBOOK_INVALID_ARGUMENT` (400)
 *   - HTTP status mapping matches `ipcErrorStatus()` table.
 *   - The workbook errors carry `.channel` so handlers / logs can pivot.
 *
 * What this file does NOT cover (kept on the legacy generic codes):
 *   - `workbook:save` unknown sessionId → still `NOT_FOUND` (generic)
 *   - `workbook:export-csv` malformed request → still `INVALID_ARGUMENT`
 *   - `workbook:read-range` session lookup → still `NOT_FOUND`
 *
 * Those channels are slated for their own conversion PR so a reviewer can
 * audit the wire shape changes in isolation. The new module is imported by
 * `sheets/index.ts` and the workbook:open-path handler already uses it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)

const skip = !haveBundle

let base = ''
let proc: ChildProcess | null = null
let dataDir = ''

async function pollHealth(target: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${target}/health`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('web-server did not become healthy')
}

async function invoke(
  target: string,
  channel: string,
  args: unknown[],
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${target}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  if (skip) return
  dataDir = mkdtempSync(join(tmpdir(), 'genoffice-workbook-errors-'))
  const port = 29500 + Math.floor(Math.random() * 4000)
  proc = spawn('node', [bundle], {
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = `http://127.0.0.1:${port}`
  await pollHealth(base, 20000)
}, 30000)

afterAll(async () => {
  if (skip) return
  await stopServer(proc, dataDir)
  proc = null
  dataDir = ''
})

describe.skipIf(skip)('workbook:open-path error code unification (sdk1 §11.59)', () => {
  it('a missing managed path returns WORKBOOK_NOT_FOUND (404)', async () => {
    // Path must live inside FILES_DIR — the handler runs requireManagedPath
    // before existsSync(), so an outside-storage path would answer 400
    // INVALID_ARGUMENT (PATH_OUTSIDE_STORAGE) instead.
    const missing = join(dataDir, 'files', 'does-not-exist.xlsx')
    const r = await invoke(base, 'workbook:open-path', [missing])
    expect(r.status).toBe(404)
    const err = (r.body as { error?: { code?: string; channel?: string } }).error
    expect(err?.code).toBe('WORKBOOK_NOT_FOUND')
    expect(err?.channel).toBe('workbook:open-path')
  })

  it('a legacy .xls file returns WORKBOOK_CORRUPT (422) with a useful reason', async () => {
    const target = join(dataDir, 'files', 'legacy.xls')
    // Minimal BIFF8 stub — the sidecar never gets to parse it; the
    // workbook:open-path handler short-circuits on the extension and
    // throws WorkbookCorruptError with the helpful "convert to .xlsx"
    // message that used to live on the generic CorruptError.
    writeFileSync(target, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
    const r = await invoke(base, 'workbook:open-path', [target])
    expect(r.status).toBe(422)
    const err = (r.body as { error?: { code?: string; channel?: string; message?: string } }).error
    expect(err?.code).toBe('WORKBOOK_CORRUPT')
    expect(err?.channel).toBe('workbook:open-path')
    expect(err?.message ?? '').toMatch(/convert to \.xlsx/i)
  })

  it('random bytes pretending to be xlsx returns WORKBOOK_CORRUPT (422)', async () => {
    const target = join(dataDir, 'files', 'garbage.xlsx')
    writeFileSync(target, Buffer.from('this is not a zip archive at all'))
    const r = await invoke(base, 'workbook:open-path', [target])
    expect(r.status).toBe(422)
    const err = (r.body as { error?: { code?: string; channel?: string } }).error
    expect(err?.code).toBe('WORKBOOK_CORRUPT')
    expect(err?.channel).toBe('workbook:open-path')
  })

  it('the error envelope still serialises .message / .code / .channel', async () => {
    // Guard against accidental regression in sendIpcError: every workbook
    // error subclass sets .code and .channel — verify both survive the
    // envelope so the renderer can branch on them.
    const missing = join(dataDir, 'files', 'missing-file.xlsx')
    const r = await invoke(base, 'workbook:open-path', [missing])
    const err = (r.body as { error?: { code?: string; channel?: string; message?: string } }).error
    expect(typeof err?.code).toBe('string')
    expect(typeof err?.channel).toBe('string')
    expect(typeof err?.message).toBe('string')
    expect(err?.message ?? '').toMatch(/File not found/i)
  })
})

describe.skipIf(skip)('workbook:open-for-merge argument validation (sdk1 §11.59)', () => {
  it('merge sources exceeding 20 returns WORKBOOK_INVALID_ARGUMENT (400)', async () => {
    const sources = Array.from({ length: 21 }, (_, i) => `/__nonexistent__/m${i}.xlsx`)
    const r = await invoke(base, 'workbook:open-for-merge', [{ sources }])
    expect(r.status).toBe(400)
    const err = (r.body as { error?: { code?: string; channel?: string } }).error
    expect(err?.code).toBe('WORKBOOK_INVALID_ARGUMENT')
    expect(err?.channel).toBe('workbook:open-for-merge')
  })

  it('merge with zero sources returns WORKBOOK_INVALID_ARGUMENT (400)', async () => {
    const r = await invoke(base, 'workbook:open-for-merge', [{ sources: [] }])
    expect(r.status).toBe(400)
    const err = (r.body as { error?: { code?: string; channel?: string } }).error
    expect(err?.code).toBe('WORKBOOK_INVALID_ARGUMENT')
  })
})

describe.skipIf(skip)('WorkbookError class contract (unit)', () => {
  // Pure unit checks — these do not require a live server, but live in the
  // .test.ts file so vitest picks them up alongside the IPC envelope tests.
  // Importing the workbook errors module verifies the class hierarchy and
  // shape every channel handler relies on.
  it('every subclass sets .code / .channel / .message', async () => {
    const { WorkbookError } = await import('../src/sheets/errors')
    const variants = [
      new (await import('../src/sheets/errors')).WorkbookNotFoundError('workbook:open-path', 'x'),
      new (await import('../src/sheets/errors')).WorkbookCorruptError('workbook:open-path', 'x'),
      new (await import('../src/sheets/errors')).WorkbookOpenFailedError('workbook:open-path', 'x'),
      new (await import('../src/sheets/errors')).WorkbookSaveFailedError('workbook:save', 'x'),
      new (await import('../src/sheets/errors')).WorkbookInvalidArgumentError('workbook:open-for-merge', 'x'),
    ]
    for (const v of variants) {
      expect(v).toBeInstanceOf(WorkbookError)
      expect(v).toBeInstanceOf(Error)
      expect(typeof v.code).toBe('string')
      expect(v.code.startsWith('WORKBOOK_')).toBe(true)
      expect(typeof v.channel).toBe('string')
      expect(v.channel.startsWith('workbook:')).toBe(true)
      expect(typeof v.message).toBe('string')
      expect(v.message.length).toBeGreaterThan(0)
    }
  })

  it('WorkbookCorruptError / OpenFailedError / SaveFailedError retain .cause', async () => {
    const { WorkbookCorruptError, WorkbookOpenFailedError, WorkbookSaveFailedError } =
      await import('../src/sheets/errors')
    const inner = new Error('inner parser stack')
    const a = new WorkbookCorruptError('workbook:open-path', 'outer', inner)
    const b = new WorkbookOpenFailedError('workbook:open-path', 'outer', inner)
    const c = new WorkbookSaveFailedError('workbook:save', 'outer', inner)
    expect(a.cause).toBe(inner)
    expect(b.cause).toBe(inner)
    expect(c.cause).toBe(inner)
    expect((a as Error & { cause?: unknown }).cause).toBe(inner)
  })

  it('WorkbookNotFoundError / WorkbookInvalidArgumentError have no .cause', async () => {
    const { WorkbookNotFoundError, WorkbookInvalidArgumentError } =
      await import('../src/sheets/errors')
    const a = new WorkbookNotFoundError('workbook:open-path', 'no path')
    const b = new WorkbookInvalidArgumentError('workbook:open-for-merge', 'bad count')
    expect(a.cause).toBeUndefined()
    expect(b.cause).toBeUndefined()
  })
})
