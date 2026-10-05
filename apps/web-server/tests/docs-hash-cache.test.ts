import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'

/**
 * A21/A54 — the docx sha256 fast path.
 *
 * `docs:open-path` and `docs:read-path` used to hash the whole payload on
 * every call, so re-opening an unchanged 20MB document burned hundreds of
 * milliseconds of CPU to recompute a value that cannot have changed. The
 * server now fingerprints documents by (size, mtime) and reuses the cached
 * hash while that fingerprint holds.
 *
 * The suite boots `dist/bundle/index.js` against a temp DATA_DIR with
 * `GENOFFICE_LOG_LEVEL=debug` so the cache decision is observable in the
 * server's own structured log — correctness (same hash) and the fast path
 * (a `sha256 cache hit` record) are asserted separately, because a handler
 * that always recomputed would satisfy the first and fail the second.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let server: ChildProcess | null = null
const port = 33023
const baseUrl = `http://127.0.0.1:${port}`
let dataDir = ''
let filesDir = ''
let stderr = ''
const cleanup: Array<() => void> = []

beforeAll(async () => {
  dataDir = mkdtempSync(`${tmpdir()}/genoffice-docs-hash-`)
  filesDir = join(dataDir, 'files')
  mkdirSync(filesDir, { recursive: true })
  cleanup.push(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  server = spawn(process.execPath, [resolve(root, 'dist/bundle/index.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      GENOFFICE_LOG_LEVEL: 'debug',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  server.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  await new Promise<void>((resolveBoot, rejectBoot) => {
    const t = setTimeout(() => rejectBoot(new Error('server boot timeout')), 15_000)
    server!.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Channels:')) {
        clearTimeout(t)
        resolveBoot()
      }
    })
  })
}, 30_000)

afterAll(async () => {
  if (server && server.exitCode === null && !server.killed) {
    await new Promise<void>((r) => {
      server!.once('exit', () => r())
      server!.kill('SIGTERM')
      setTimeout(() => {
        if (server && !server.killed) server.kill('SIGKILL')
        r()
      }, 5_000).unref?.()
    })
  }
  cleanup.forEach((fn) => fn())
})

async function invoke(
  channel: string,
  args: unknown[],
): Promise<{ status: number; body: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } }> {
  const res = await fetch(`${baseUrl}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return {
    status: res.status,
    body: (await res.json()) as {
      ok?: boolean
      result?: unknown
      error?: { code?: string; message?: string }
    },
  }
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

// Real docx bytes matter here: `docs:open-path` runs the magic-byte gate
// before hashing, and a stub without the zip header is rejected with a
// structured error instead of reaching the cache at all.
function docxBytes(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8')
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), body])
}

describe('docx sha256 fast path (A21/A54)', () => {
  it('serves the second open of an unchanged file from the cache', async () => {
    const path = join(filesDir, `hash-a-${Date.now()}.docx`)
    const bytes = docxBytes('first revision')
    writeFileSync(path, bytes)

    const first = await invoke('docs:open-path', [path])
    expect(first.status).toBe(200)
    const firstHash = (first.body.result as { hash: string }).hash
    const expected = sha256Of(bytes)
    expect(firstHash).toBe(expected)

    const hitsBefore = countCacheHits(path)
    const second = await invoke('docs:open-path', [path])
    const secondHash = (second.body.result as { hash: string }).hash
    // Correctness: the returned hash still describes the file's bytes.
    expect(secondHash).toBe(expected)
    // Fast path: the second open did not rehash the payload.
    expect(countCacheHits(path)).toBeGreaterThan(hitsBefore)
  })

  it('rehashes after the content changes', async () => {
    const path = join(filesDir, `hash-b-${Date.now()}.docx`)
    writeFileSync(path, docxBytes('revision one'))
    const first = (await invoke('docs:open-path', [path])).body.result as { hash: string }

    writeFileSync(path, docxBytes('revision two is longer'))
    const hitsBefore = countCacheHits(path)
    const second = (await invoke('docs:open-path', [path])).body.result as { hash: string }
    expect(second.hash).not.toBe(first.hash)
    expect(second.hash).toBe(sha256Of(readFileSync(path)))
    // A changed file must not have been served from the old entry.
    expect(countCacheHits(path)).toBe(hitsBefore)
  })

  it('rehashes a same-size rewrite once mtime moves', async () => {
    const path = join(filesDir, `hash-c-${Date.now()}.docx`)
    const v1 = docxBytes('aaaa')
    writeFileSync(path, v1)
    const first = (await invoke('docs:open-path', [path])).body.result as { hash: string }

    // Same byte length, different content: size alone cannot detect this, so
    // the mtime half of the fingerprint is what has to carry it.
    const v2 = docxBytes('bbbb')
    expect(v2.byteLength).toBe(v1.byteLength)
    writeFileSync(path, v2)
    const bumped = new Date(statSync(path).mtimeMs + 5_000)
    utimesSync(path, bumped, bumped)

    const second = (await invoke('docs:open-path', [path])).body.result as { hash: string }
    expect(second.hash).not.toBe(first.hash)
    expect(second.hash).toBe(sha256Of(v2))
  })

  it('shares one cache entry across the storage-URI and absolute spellings', async () => {
    const key = `hash-d-${Date.now()}.docx`
    const path = join(filesDir, key)
    writeFileSync(path, docxBytes('shared entry'))

    const viaPath = (await invoke('docs:open-path', [path])).body.result as { hash: string }
    const uri = `storage://local/${key}`
    const hitsBefore = countCacheHits(path)
    const viaUri = (await invoke('docs:open-path', [uri])).body.result as { hash: string }
    expect(viaUri.hash).toBe(viaPath.hash)
    expect(countCacheHits(path)).toBeGreaterThan(hitsBefore)
  })

  it('caches docs:read-path as well', async () => {
    const path = join(filesDir, `hash-e-${Date.now()}.docx`)
    writeFileSync(path, docxBytes('read path caching'))
    const first = (await invoke('docs:read-path', [path])).body.result as { hash: string } | null
    expect(first?.hash).toBeTruthy()
    const hitsBefore = countCacheHits(path)
    const second = (await invoke('docs:read-path', [path])).body.result as { hash: string } | null
    expect(second?.hash).toBe(first?.hash)
    expect(countCacheHits(path)).toBeGreaterThan(hitsBefore)
  })
})

/** Cache-hit records the server logged for one path so far. */
function countCacheHits(path: string): number {
  return stderr
    .split('\n')
    .filter((line) => line.includes('"msg":"sha256 cache hit"') && line.includes(path)).length
}
