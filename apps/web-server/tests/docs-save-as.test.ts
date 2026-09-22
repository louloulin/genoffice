import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

/**
 * docs:save-as — channel parity with workbook:save-as / slides:save-as.
 *
 * The previous web build had no `docs:save-as` channel; the docs
 * renderer's "save as" silently round-tripped through `docs:save` (which
 * kept the original path and ignored the new name). Adding the channel
 * brings docs in line with sheets & slides.
 *
 * The suite boots `dist/bundle/index.js` against a temp DATA_DIR and
 * exercises two flows:
 *   1) save-as with explicit `data` bytes → bytes land at `targetPath`
 *      and the source path is untouched.
 *   2) save-as without `data` → bytes are read from `sourcePath` and
 *      copied to `targetPath`.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

let server: ChildProcess | null = null
let port = 0
let baseUrl = ''
let dataDir = ''
const cleanup: Array<() => void> = []

beforeAll(async () => {
  dataDir = mkdtempSync(`${tmpdir()}/genoffice-docs-save-as-`)
  cleanup.push(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  port = 33010
  baseUrl = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [resolve(root, 'dist/bundle/index.js')], {
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // Wait for the boot banner.
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

async function invoke(channel: string, args: unknown[]): Promise<{ status: number; body: { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } }> {
  const res = await fetch(`${baseUrl}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: res.status, body: (await res.json()) as { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } }
}

// A minimal valid docx: zip header + 2 trailing bytes. The handler only
// checks byteLength > 0 and the .docx extension; it does NOT validate
// magic bytes (the magic gate is enforced at read time, not save time).
const SAMPLE_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x99, 0x99])

describe('docs:save-as channel (parity with sheets / slides)', () => {
  it('writes the supplied data bytes to a brand-new target path', async () => {
    const source = `${dataDir}/source.docx`
    const target = `${dataDir}/target.docx`
    writeFileSync(source, SAMPLE_BYTES)
    const r = await invoke('docs:save-as', [source, target, Array.from(SAMPLE_BYTES)])
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
    const result = r.body.result as { ok?: boolean; path?: string }
    expect(result.ok).toBe(true)
    expect(result.path).toBe(target)
    expect(existsSync(target)).toBe(true)
    const written = readFileSync(target)
    expect(written.length).toBe(SAMPLE_BYTES.length)
    expect(Buffer.compare(written, SAMPLE_BYTES)).toBe(0)
    // Source untouched.
    expect(Buffer.compare(readFileSync(source), SAMPLE_BYTES)).toBe(0)
  })

  it('copies bytes from sourcePath when no `data` arg is supplied', async () => {
    const source = `${dataDir}/src2.docx`
    const target = `${dataDir}/dst2.docx`
    writeFileSync(source, SAMPLE_BYTES)
    const r = await invoke('docs:save-as', [source, target])
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
    const result = r.body.result as { ok?: boolean; path?: string }
    expect(result.ok).toBe(true)
    expect(result.path).toBe(target)
    expect(existsSync(target)).toBe(true)
    const written2 = readFileSync(target)
    expect(written2.length).toBe(SAMPLE_BYTES.length)
    expect(Buffer.compare(written2, SAMPLE_BYTES)).toBe(0)
  })

  it('rejects empty source / target paths with a structured error', async () => {
    const r = await invoke('docs:save-as', ['', ''])
    expect(r.status).toBe(400)
    expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
  })

  it('returns a structured NOT_FOUND when the source path is missing and no data supplied', async () => {
    // Place both paths inside the server's FILES_DIR (dataDir + '/files')
    // so the storage gate passes; the source is then deliberately absent
    // to exercise the readDocxBytes → NotFoundError path.
    const source = `${dataDir}/files/nope-${Date.now()}.docx`
    const target = `${dataDir}/files/out-${Date.now()}.docx`
    const r = await invoke('docs:save-as', [source, target])
    expect(r.status).toBe(404)
    expect(r.body.error?.code).toBe('NOT_FOUND')
  })
})


