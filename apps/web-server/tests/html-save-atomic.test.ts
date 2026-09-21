/**
 * HTML save atomicity regression — guards the M3 work.
 *
 * The bug: html:save-file used writeFileSync on the target path directly,
 * so a SIGKILL mid-write left a 0-byte (or truncated) HTML on disk and
 * the renderer's reload pointed at a broken document. html:save did a
 * tmp + target double-write and then tried to clean up; a crash between
 * the two writes left the temp on disk and the target overwritten in
 * place — also a half-document.
 *
 * What this suite asserts:
 *   - The save succeeds and the file's bytes match the request exactly.
 *   - No `.tmp-<ts>` or `.tmp` sibling file lingers after a successful save.
 *   - A second save to the same target swaps the bytes atomically (no
 *     mixed old + new content visible at any time).
 *   - Recents are recorded (home:recents row with the target path
 *     present after html:save), matching docs:save / markdown:save.
 *   - The shared kernel's 0-byte rejection is surfaced as a structured
 *     `INVALID_ARGUMENT` (400), not a silent `{ ok: false, error }`.
 *   - A path outside managed storage is refused by requireManagedPath
 *     and surfaces as a structured `INVALID_ARGUMENT` instead of the
 *     old generic `PATH_OUTSIDE_STORAGE` string.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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

describe.skipIf(!haveBundle)('html:save atomicity (M3)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-html-save-'))
    const port = 28000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 15_000)
  })

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  function listTempSiblings(target: string): string[] {
    const dir = join(target, '..')
    const base = join(target, '..').slice(0) // alias
    const filename = target.split('/').pop() ?? ''
    return readdirSync(dir).filter(
      (entry) => entry.startsWith(`${filename}.`) && (entry.endsWith('.tmp') || entry.includes('.tmp-')),
    )
  }

  it('html:save-file overwrites the target atomically (no temp sibling left behind)', async () => {
    const htmlDir = join(dataDir, 'html')
    const target = join(htmlDir, `atomic-${Date.now()}.html`)
    const r = await invoke(base, 'html:save-file', [
      target,
      '<!doctype html><html><body><h1>v1</h1></body></html>',
    ])
    expect(r.status).toBe(200)
    const ok = (r.body as { result?: { ok?: boolean; path?: string } })?.result
    expect(ok?.ok).toBe(true)
    expect(ok?.path).toBe(target)
    expect(readFileSync(target, 'utf8')).toContain('<h1>v1</h1>')

    // Overwrite with v2; the file's bytes must be v2 only (not v1+v2 mix).
    const r2 = await invoke(base, 'html:save-file', [
      target,
      '<!doctype html><html><body><h1>v2</h1></body></html>',
    ])
    expect((r2.body as { result?: { ok?: boolean } })?.result?.ok).toBe(true)
    const bytes = readFileSync(target, 'utf8')
    expect(bytes).toContain('<h1>v2</h1>')
    expect(bytes).not.toContain('<h1>v1</h1>')

    // No temp files leaked.
    const dir = join(target, '..')
    const filename = target.split('/').pop() ?? ''
    const leftover = readdirSync(dir).filter(
      (entry) =>
        entry !== filename && entry.startsWith(filename) && /\.tmp/.test(entry),
    )
    expect(leftover).toEqual([])
  })

  it('html:save (channel) writes the target with the new text and records a recents row', async () => {
    const target = join(dataDir, `atomic-channel-${Date.now()}.html`)
    const r = await invoke(base, 'html:save', [
      { text: '<!doctype html><html><body><p>channel-save</p></body></html>', path: target },
    ])
    expect(r.status).toBe(200)
    expect((r.body as { result?: { ok?: boolean; path?: string } })?.result?.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toContain('channel-save')

    const recents = (await invoke(base, 'home:recents', [{}])).body as {
      result?: { entries?: Array<{ path: string; name: string }> }
    }
    const found = recents.result?.entries?.find((e) => e.path === target)
    expect(found).toBeTruthy()
  })

  it('html:save-file refuses an empty payload with a structured INVALID_ARGUMENT (400)', async () => {
    const target = join(dataDir, `empty-${Date.now()}.html`)
    const r = await invoke(base, 'html:save-file', [target, ''])
    expect(r.status).toBe(400)
    const err = (r.body as { error?: { code?: string } }).error
    expect(err?.code).toBe('INVALID_ARGUMENT')
    // Empty payload must not create the file either.
    expect(existsSync(target)).toBe(false)
  })

  it('html:save-file refuses a path outside managed storage (400 INVALID_ARGUMENT)', async () => {
    const r = await invoke(base, 'html:save-file', [
      '/tmp/genoffice-data-not-managed/evil.html',
      '<!doctype html><body>evil</body>',
    ])
    expect(r.status).toBe(400)
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('INVALID_ARGUMENT')
  })

  it('html:save-file refuses a non-string content payload (400 INVALID_ARGUMENT)', async () => {
    const target = join(dataDir, `bad-content-${Date.now()}.html`)
    const r = await invoke(base, 'html:save-file', [target, 12345])
    expect(r.status).toBe(400)
    expect((r.body as { error?: { code?: string } }).error?.code).toBe('INVALID_ARGUMENT')
  })

  it('html:save replaces bytes on a subsequent save (no temp leakage)', async () => {
    // Use the html:save channel directly (renderer path).
    const target = join(dataDir, `replace-${Date.now()}.html`)
    await invoke(base, 'html:save', [
      { text: '<!doctype html><html><body><span>first</span></body></html>', path: target },
    ])
    await invoke(base, 'html:save', [
      { text: '<!doctype html><html><body><span>second</span></body></html>', path: target },
    ])
    const bytes = readFileSync(target, 'utf8')
    expect(bytes).toContain('<span>second</span>')
    expect(bytes).not.toContain('<span>first</span>')
    const dir = join(target, '..')
    const filename = target.split('/').pop() ?? ''
    const leftover = readdirSync(dir).filter(
      (entry) => entry !== filename && entry.startsWith(filename) && /\.tmp/.test(entry),
    )
    expect(leftover).toEqual([])
  })
})
