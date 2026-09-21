/**
 * A multi-file drop fires `web:save-file` once per file with no back-pressure,
 * so the uploads land concurrently on the same event loop. The failure this
 * suite guards against is silent: ids built from `Date.now()` alone repeat
 * within a millisecond, so two of the 100 files share an id and one overwrites
 * the other in the in-memory index. The user sees 99 files instead of 100, and
 * nothing errors.
 *
 * The suite boots the real bundle because the race lives in the handler plus
 * the persistence layer, not in either alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)

const BURST = 100

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

describe.skipIf(!haveBundle)('concurrent uploads', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-burst-'))
    const port = 27000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', GENOFFICE_DATA_DIR: dataDir },
      stdio: 'ignore',
    })
    await pollHealth(base, 30_000)
  }, 60_000)

  afterAll(() => stopServer(server, dataDir))

  it(`lands all ${BURST} parallel uploads with distinct ids`, async () => {
    const results = await Promise.all(
      Array.from({ length: BURST }, (_, i) =>
        invoke(base, 'web:save-file', [
          {
            name: `burst-${i}.txt`,
            bytes: new TextEncoder().encode(`payload ${i}`).buffer,
            projectId: 'proj-default',
          },
        ]),
      ),
    )

    for (const [i, r] of results.entries()) {
      expect(r.status, `upload ${i}`).toBe(200)
    }
    const ids = results.map((r) => (r.body as { result?: { id?: string } }).result?.id)
    expect(ids.every((id) => typeof id === 'string')).toBe(true)
    // The regression: a colliding id means one upload silently won.
    expect(new Set(ids).size).toBe(BURST)
  }, 60_000)

  it('writes every payload to disk with its own bytes', async () => {
    const filesDir = join(dataDir, 'files')
    /* Content-addressed keys live under <yyyy>/<mm>/<dd>/, so the
     * walk has to be recursive. The same name collisions that motivated
     * content addressing in the first place (a burst of identical
     * timestamps) also collapse into one file when bytes match, so
     * `BURST` distinct payloads may produce fewer entries here. The
     * set-of-payloads assertion below is what matters. */
    const collectFiles = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...collectFiles(full))
        else if (!entry.name.startsWith('.')) out.push(full)
      }
      return out
    }
    const entries = collectFiles(filesDir)
    expect(entries.length).toBeGreaterThan(0)
    const seen = new Set<string>()
    for (const full of entries) {
      seen.add(readFileSync(full, 'utf-8'))
    }
    // Every distinct payload must be present exactly once.
    for (let i = 0; i < BURST; i += 1) {
      expect(seen.has(`payload ${i}`), `payload ${i}`).toBe(true)
    }
  }, 60_000)

  it('persists the whole burst to a parseable files-index.json', async () => {
    const indexFile = join(dataDir, 'files-index.json')
    expect(existsSync(indexFile)).toBe(true)
    const rows = JSON.parse(readFileSync(indexFile, 'utf-8')) as Array<{ id: string }>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThanOrEqual(BURST)
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length)
  }, 60_000)

  it('resolves each id back to its file through files:read after the burst', async () => {
    const indexFile = join(dataDir, 'files-index.json')
    const rows = JSON.parse(readFileSync(indexFile, 'utf-8')) as Array<{ id: string; path: string }>
    const sample = rows.slice(0, 10)
    const reads = await Promise.all(
      sample.map((row) => invoke(base, 'files:read', [{ id: row.id }])),
    )
    for (const [i, r] of reads.entries()) {
      expect(r.status, `read ${sample[i].id}`).toBe(200)
      const body = r.body as { result?: { path?: string; content?: string } }
      expect(body.result?.path).toBe(sample[i].path)
      expect(typeof body.result?.content).toBe('string')
    }
  }, 60_000)
})
