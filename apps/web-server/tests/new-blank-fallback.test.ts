/**
 * Regression coverage for the cold-start recents bug:
 * `slides:new-blank` and `sheets:new-blank` used to append a recents row
 * pointing at a path the server had never written to. The home grid then
 * surfaced a "missing" tile that could not be opened.
 *
 * Both handlers now fall back to the embedded blank-template buffer when
 * the caller hands them neither bytes nor a pre-existing path. This test
 * exercises the bundle end-to-end against a temp DATA_DIR and asserts
 *   - the returned `path` is on disk
 *   - the file parses (pptx / xlsx sidecar opens it)
 *   - `home:recents` returns a row whose `missing` flag is false
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeTransportValue } from '../src/common/codec'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')

const haveBundle = existsSync(bundle)

async function pollHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 250))
  }
  throw new Error('web-server did not become healthy')
}

async function invoke(
  base: string,
  channel: string,
  args: unknown[],
): Promise<{ status: number; body: unknown }> {
  const encoded = args.map((arg) => encodeTransportValue(arg))
  const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: encoded }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}


function validateZipCentralDirectory(path: string): boolean {
  /* Node ships no public API for "is this a valid zip?", but we can rely
   * on the fact that every JSZip/ZipFile consumer blows up on
   * "Can't find end of central directory" when the trailer is missing.
   * Reading the last 64 KiB and looking for the EOCD signature (PK\x05\x06)
   * is enough to catch the truncation class of bugs the template fix
   * protects against. */
  const fd = readFileSync(path)
  const tail = fd.subarray(Math.max(0, fd.byteLength - 65536))
  for (let i = 0; i < tail.byteLength - 3; i++) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      return true
    }
  }
  return false
}

describe.skipIf(!haveBundle)('new-blank fallback to embedded template', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-newblank-'))
    const port = 26000 + Math.floor(Math.random() * 1000)
    base = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        GENOFFICE_DATA_DIR: dataDir,
      },
      stdio: 'ignore',
    })
    await pollHealth(base, 30_000)
  }, 60_000)

  afterAll(() => stopServer(server, dataDir))

  it('slides:new-blank materialises a real pptx (verified via home:recents)', async () => {
    /* slides:new-blank intentionally returns path: '' so the renderer falls
     * through to its own blank-deck renderer; the recents row the server
     * appends is the only on-disk pointer we can observe from outside. */
    const r = await invoke(base, 'slides:new-blank', [undefined])
    expect(r.status).toBe(200)
    const list = (
      await invoke(base, 'home:recents', [{ offset: 0, limit: 1, ext: 'pptx' }])
    ).body as {
      ok: true
      result: {
        entries: Array<{ path: string; missing?: boolean; sizeBytes: number; name: string }>
      }
    }
    const row = list.result.entries[0]
    expect(row, 'a new pptx row should appear in recents').toBeDefined()
    expect(row.name).toMatch(/^演示文稿-.*\.pptx$/)
    expect(row.missing).not.toBe(true)
    expect(row.path).toMatch(/\.pptx$/)
    expect(existsSync(row.path)).toBe(true)
    /* A pptx is a zip; the template is several KB. Anything below ~512
     * bytes means the fallback did not run. */
    expect(statSync(row.path).size).toBeGreaterThan(512)
    /* The pptx must also be a structurally valid zip — the editor refuses
     * to open anything else. The previous template shipped with a
     * corrupt central directory and the editor then surfaced a parse
     * error banner rather than a blank deck. */
    expect(validateZipCentralDirectory(row.path), 'embedded pptx must be a valid zip').toBe(true)
  })

  it('sheets:new-blank writes a real xlsx when called without bytes', async () => {
    const r = await invoke(base, 'sheets:new-blank', [undefined])
    expect(r.status).toBe(200)
    const body = r.body as { ok: true; result: { id: string; path: string; name: string } }
    expect(body.ok).toBe(true)
    const { path } = body.result
    expect(path).toMatch(/\.xlsx$/)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(512)
    /* xlsx must also be a structurally valid zip; the embedded xlsx
     * template shipped with no central directory, which made
     * workbook:open-path fail with "Failed to parse workbook". */
    expect(validateZipCentralDirectory(path), 'embedded xlsx must be a valid zip').toBe(true)
  })

  it('home:recents surfaces the freshly-created slides deck as not missing', async () => {
    /* slides:new-blank intentionally returns path: '' so the renderer falls
     * through to its own blank-deck renderer. We resolve the real on-disk
     * path from the slides:recent channel that the server itself maintains. */
    await invoke(base, 'slides:new-blank', [undefined])
    /* recordRecentDoc is debounced (250ms by default) before the unified
     * store writes to disk; allow time for it to land before querying. */
    await new Promise((res) => setTimeout(res, 500))
    const slidesRecent = (
      await invoke(base, 'slides:recent', [])
    ).body as { ok: true; result: Array<{ path: string }> }
    const createdPath = slidesRecent.result[0]?.path
    const list = (
      await invoke(base, 'home:recents', [{ offset: 0, limit: 50, ext: 'pptx' }])
    ).body as {
      ok: true
      result: {
        entries: Array<{ path: string; missing?: boolean }>
      }
    }
    const row = list.result.entries.find(
      (e) => e.path === createdPath,
    )
    expect(row, 'recents should include the just-created deck').toBeDefined()
    expect(row!.missing).not.toBe(true)
  })
})
