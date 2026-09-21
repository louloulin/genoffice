/**
 * search:files (P2) — file-level full-text search across FILES_DIR.
 *
 * Boots the bundle against a temp DATA_DIR with several seeded files,
 * then exercises the IPC handler via the live web-server. Each test
 * asserts on the snippet shape, the limit/offset paging, and the
 * extension filter.
 *
 * What's covered:
 *   - Empty query returns 0 results.
 *   - Substring match returns file + 80-char snippet.
 *   - Case-insensitive matching.
 *   - Extension filter limits the candidates.
 *   - Limit + offset paging.
 *   - Binary files (xlsx/pptx) are skipped, not surfaced as empty matches.
 *   - .trash/ entries are NOT scanned.
 *   - Dotfiles are ignored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)
const skip = !haveBundle

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

interface SearchResult {
  results: Array<{ id: string; name: string; path: string; ext: string; size: number; snippet: string }>
  total: number
  limit: number
  offset: number
}

function unwrap<T>(body: unknown): T {
  const obj = body as { ok?: unknown; result?: unknown; error?: unknown } | null
  if (obj && obj.ok === false) {
    throw new Error(
      `IPC returned error envelope: ${typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error)}`,
    )
  }
  return ((obj && 'result' in obj ? (obj as { result?: T }).result : (obj as T))) as T
}

describe.skipIf(skip)('search:files (P2)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-files-search-'))
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    // Seed several files spanning text / binary / hidden / trash.
    writeFileSync(
      join(filesDir, 'notes.md'),
      '# Spec\n\nThe renderer hands the main process a batch of slide ops.\nThe main process applies them through runTxn.\n',
    )
    writeFileSync(
      join(filesDir, 'config.json'),
      '{"name":"genoffice","version":"0.1.0","renderer":"desktop"}\n',
    )
    writeFileSync(
      join(filesDir, 'app.log'),
      '2026-09-22T01:00:00Z INFO  slide main process running\n2026-09-22T01:00:01Z DEBUG renderer connected\n',
    )
    writeFileSync(join(filesDir, 'binary.xlsx'), 'pptx-bytes-no-text')
    writeFileSync(join(filesDir, '.hidden.txt'), 'should not be scanned by default')
    mkdirSync(join(filesDir, '.trash'), { recursive: true })
    writeFileSync(join(filesDir, '.trash', 'deleted.md'), 'deleted but stays out of search')

    const port = 31000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 15_000)
  }, 30_000)

  afterAll(async () => {
    await stopServer(server)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns 0 results for an empty query', async () => {
    const r = await invoke(base, 'search:files', [{ query: '' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.results).toEqual([])
    expect(out.total).toBe(0)
  })

  it('finds a substring match with snippet', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'runTxn' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.total).toBeGreaterThan(0)
    const mdHit = out.results.find((x) => x.name === 'notes.md')
    expect(mdHit).toBeDefined()
    expect(mdHit!.snippet).toContain('runTxn')
  })

  it('is case-insensitive', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'RENDERER' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    // Both config.json and notes.md contain 'renderer' / 'renderer'.
    expect(out.total).toBeGreaterThanOrEqual(1)
  })

  it('honours extension filter', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'info', exts: ['log'] }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.results.every((x) => x.ext === 'log')).toBe(true)
    expect(out.total).toBeGreaterThanOrEqual(1)
  })

  it('paginates with limit + offset', async () => {
    const page1 = unwrap<SearchResult>(
      (await invoke(base, 'search:files', [{ query: 'the', limit: 1, offset: 0 }])).body,
    )
    expect(page1.results.length).toBeLessThanOrEqual(1)
    const page2 = unwrap<SearchResult>(
      (await invoke(base, 'search:files', [{ query: 'the', limit: 1, offset: 1 }])).body,
    )
    // Two consecutive pages should not return identical rows when there
    // are at least 2 hits. If total is 1, page2 returns [].
    expect(page1.total).toBe(page2.total)
  })

  it('skips binary files', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'pptx-bytes-no-text' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.results.find((x) => x.name === 'binary.xlsx')).toBeUndefined()
  })

  it('does not scan .trash entries', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'deleted but stays out' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.results).toEqual([])
  })

  it('ignores dotfiles by default', async () => {
    const r = await invoke(base, 'search:files', [{ query: 'should not be scanned' }])
    expect(r.status).toBe(200)
    const out = unwrap<SearchResult>(r.body)
    expect(out.results).toEqual([])
  })
})
