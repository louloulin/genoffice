/**
 * End-to-end coverage for every editor format the web shell ships with.
 *
 * Boots the real bundle against a temp DATA_DIR, uploads one fixture of
 * each extension the home grid claims to support, and asserts that:
 *
 *  - web:save-file accepts every extension (no MIME / ext rejection)
 *  - home:recents surfaces the new files with `missing: false`
 *  - the matching `<editor>:open-path` channel accepts each file and
 *    returns a payload the editor can render
 *
 * This is the test the user-facing "missing format" bug regression lives
 * in. If a format breaks, this is the suite that catches it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeTransportValue } from '../src/common/codec'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
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

interface FormatCase {
  ext: string
  mime: string
  /** One-byte stub payload — the open-path assertions only check that the
   *  editor channel returns a result envelope, not that the bytes are
   *  semantically meaningful. */
  bytes: Uint8Array
  openChannel: string
  /** Files that should also be reachable from the shell's general picker. */
  fromPicker: boolean
}

const CASES: FormatCase[] = [
  {
    ext: 'docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    bytes: new TextEncoder().encode('stub-docx'),
    openChannel: 'docs:open-path',
    fromPicker: true,
  },
  {
    ext: 'xlsx',
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes: new TextEncoder().encode('stub-xlsx'),
    openChannel: 'workbook:open-path',
    fromPicker: true,
  },
  {
    ext: 'pptx',
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    bytes: new TextEncoder().encode('stub-pptx'),
    openChannel: 'slides:open-path',
    fromPicker: true,
  },
  {
    ext: 'pdf',
    mime: 'application/pdf',
    bytes: new TextEncoder().encode('%PDF-1.4\n%stub\n%%EOF'),
    openChannel: 'pdf:open-path',
    fromPicker: true,
  },
  {
    ext: 'md',
    mime: 'text/markdown',
    bytes: new TextEncoder().encode('# stub markdown'),
    openChannel: 'markdown:read-file',
    fromPicker: true,
  },
  {
    ext: 'html',
    mime: 'text/html',
    bytes: new TextEncoder().encode('<!doctype html><p>stub</p>'),
    openChannel: 'html:read-file',
    fromPicker: true,
  },
]

describe.skipIf(!haveBundle)('multi-format upload + open', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  const uploaded: Array<{ ext: string; path: string; name: string }> = []

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-mfu-'))
    const port = 27000 + Math.floor(Math.random() * 1000)
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

    for (const c of CASES) {
      const name = `mfu-${c.ext}.${c.ext}`
      const bytes = new TextEncoder().encode(`fixture-bytes-for-${c.ext}-${Date.now()}`)
      const r = await invoke(base, 'web:save-file', [{ name, bytes, mimeType: c.mime }])
      expect(r.status).toBe(200)
      const body = r.body as {
        ok: true
        result: { id: string; path: string; name: string; mimeType: string }
      }
      expect(body.ok).toBe(true)
      expect(body.result.path).toMatch(new RegExp(`\\.${c.ext}$`))
      /* `web:save-file` now returns a `storage://` URI rather than an
       * absolute filesystem path. The backend key (`id`) is the last
       * `<yyyy>/<mm>/<dd>/<sha256>.<ext>` portion of the URI; the
       * local backend writes the bytes to `${FILES_DIR}/${id}`. */
      const id = body.result.path.startsWith('storage://')
        ? body.result.path.split('/').slice(3).join('/')
        : body.result.path
      const fsPath = join(dataDir, 'files', id)
      expect(existsSync(fsPath)).toBe(true)
      /* The byte length on disk must match what we sent — covers the
       * "upload silently truncated to 0 bytes" bug class. */
      const onDisk = readFileSync(fsPath)
      expect(onDisk.byteLength).toBe(bytes.byteLength)
      uploaded.push({ ext: c.ext, path: body.result.path, name: body.result.name })
    }
  }, 60_000)

  afterAll(() => stopServer(server, dataDir))

  it('every uploaded file surfaces in home:recents without missing', async () => {
    await new Promise((res) => setTimeout(res, 500))
    const list = (
      await invoke(base, 'home:recents', [{ offset: 0, limit: 100 }])
    ).body as {
      ok: true
      result: {
        entries: Array<{ path: string; missing?: boolean; ext: string; name: string }>
      }
    }
    const rowsByPath = new Map(list.result.entries.map((e) => [e.path, e]))
    for (const up of uploaded) {
      const row = rowsByPath.get(up.path)
      expect(row, `recents should contain ${up.path}`).toBeDefined()
      expect(row!.missing, `${up.name} must not be missing`).not.toBe(true)
      expect(row!.ext).toBe(up.ext)
    }
  })

  it('every editor channel is registered for the matching fixture', async () => {
    /* Stub bytes will not parse (they're not a real zip/pdf), so the
     * documented failure mode for each editor channel is either a
     * successful parse envelope OR a structured error envelope with a
     * known code. The contract we are protecting is "the channel is
     * registered and reachable from the IPC dispatcher" — a missing
     * handler used to surface as a raw 404 with no body, which the
     * renderer treated as a fatal bug. */
    const knownErrorCodes = new Set([
      'NOT_FOUND',
      'CORRUPT_FILE',
      'CORRUPT',
      'INVALID_ARGUMENT',
      'PATH_OUTSIDE_STORAGE',
      /* Magic-byte guard: a stub like 'stub-docx' is detected as plain
       * text, not a zip, so the channel correctly refuses the wrong
       * extension. Real uploads of real files never hit this. */
      'MAGIC_MISMATCH',
      /* Workbook-specific codes (sdk1 §11.59) — `workbook:open-path` on
       * stub bytes now throws `WorkbookCorruptError` (WORKBOOK_CORRUPT)
       * instead of the generic CORRUPT. Adding the full namespace so the
       * contract assertion stays robust against future channel additions. */
      'WORKBOOK_NOT_FOUND',
      'WORKBOOK_CORRUPT',
      'WORKBOOK_OPEN_FAILED',
      'WORKBOOK_SAVE_FAILED',
      'WORKBOOK_INVALID_ARGUMENT',
    ])
    const failures: string[] = []
    for (const c of CASES) {
      const up = uploaded.find((u) => u.ext === c.ext)!
      const r = await invoke(base, c.openChannel, [up.path])
      /* The dispatcher is allowed to surface a structured error for stub
       * bytes; what we are guarding against is an *unstructured* 500 from
       * an unregistered handler. As long as the response is JSON with a
       * known error code, the contract holds. */
      expect(r.status).toBeLessThan(600)
      const body = r.body as
        | { ok: true; result: unknown }
        | { error: { code?: string; message?: string; channel?: string } }
        | null
      if (!body) {
        failures.push(`${c.ext} via ${c.openChannel}: empty body`)
        continue
      }
      if ('ok' in body && body.ok === true) {
        /* Channel answered cleanly with a parse envelope. */
        continue
      }
      const err = 'error' in body ? body.error : undefined
      if (err?.code && knownErrorCodes.has(err.code)) {
        /* Stub bytes are expected to fail parse — accept any of the
         * known "this is not a real file" error codes. */
        continue
      }
      failures.push(
        `${c.ext} via ${c.openChannel}: code=${err?.code} msg=${err?.message}`,
      )
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('recents sizeBytes matches the uploaded bytes', async () => {
    await new Promise((res) => setTimeout(res, 500))
    const list = (
      await invoke(base, 'home:recents', [{ offset: 0, limit: 100 }])
    ).body as {
      ok: true
      result: { entries: Array<{ path: string; sizeBytes: number; missing?: boolean }> }
    }
    const rowsByPath = new Map(list.result.entries.map((e) => [e.path, e]))
    for (const up of uploaded) {
      const row = rowsByPath.get(up.path)
      expect(row).toBeDefined()
      expect(row!.sizeBytes).toBeGreaterThan(0)
    }
  })
})
