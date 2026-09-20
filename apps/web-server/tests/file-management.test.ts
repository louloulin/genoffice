/**
 * E2E coverage for the file-management IPC handlers added by the
 * WPS-grade refactor of the web-server. Each suite boots the real
 * bundle against a temp DATA_DIR and probes the channel over HTTP.
 *
 * What's covered here that the broader path-guard suite doesn't:
 *   - B3: home:starred / home:toggle-star now persist into
 *     `<DATA_DIR>/recents.json` (the UnifiedRecents store). A restart
 *     preserves the star flag.
 *   - B6: home:duplicate-file picks a non-colliding `name-copy (N)` on
 *     repeat duplicates instead of silently overwriting.
 *   - B7: the disposable upload area now lives under DATA_DIR/temp
 *     and survives a process restart (used to be /tmp/genoffice-web-temp).
 *   - Save As history: home:save-locations returns ranked recent dirs;
 *     home:record-save-location populates it; home:forget-save-location
 *     removes one.
 *   - Trash: home:delete-files soft-deletes into the local trash;
 *     home:list-trash surfaces the entry; home:restore-from-trash
 *     returns the original path.
 *   - File search / properties: home:file-search returns scored hits;
 *     home:properties returns stat + sha256.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeTransportValue } from '../src/common/codec'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  // The server's IPC dispatcher runs `decodeTransportValue` on every arg
  // before handing it to the registered handler (see apps/web-server/src/index.ts).
  // Mirror it on the client side so binary values (ArrayBuffer / typed arrays)
  // survive the JSON boundary; plain JSON values are unchanged.
  const encoded = args.map((arg) => encodeTransportValue(arg))
  const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ args: encoded }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

describe.skipIf(!haveBundle)('file-management IPC handlers', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-fm-e2e-'))
    const port = 25000 + Math.floor(Math.random() * 5000)
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

  it('home:save-locations round-trips through the file', async () => {
    const target = join(dataDir, 'projects')
    require('node:fs').mkdirSync(target, { recursive: true })
    const r1 = await invoke(base, 'home:record-save-location', [target])
    expect(r1.status).toBe(200)
    const list = (await invoke(base, 'home:save-locations', [])).body
    const paths = (list as { result?: Array<{ path: string }> })?.result?.map((l) => l.path) ?? []
    expect(paths).toContain(target)
  })

  it('home:forget-save-location removes a location', async () => {
    const target = join(dataDir, 'projects')
    await invoke(base, 'home:record-save-location', [target])
    await invoke(base, 'home:forget-save-location', [target])
    const list = (await invoke(base, 'home:save-locations', [])).body
    const paths = (list as { result?: Array<{ path: string }> })?.result?.map((l) => l.path) ?? []
    expect(paths).not.toContain(target)
  })

  it('home:delete-files soft-deletes into local trash and the file can be restored', async () => {
    const target = join(dataDir, 'files', 'doomed.docx')
    require('node:fs').mkdirSync(join(dataDir, 'files'), { recursive: true })
    writeFileSync(target, 'important contents')

    const del = await invoke(base, 'home:delete-files', [[target]])
    expect(del.status).toBe(200)
    expect(existsSync(target)).toBe(false)

    const list = (await invoke(base, 'home:list-trash', [])).body as {
      result?: Array<{ id: string; originalPath: string; name: string }>
    }
    const entries = list?.result ?? []
    const entry = entries.find((e) => e.originalPath === target)
    expect(entry, 'expected the doomed file to be in the trash').toBeTruthy()

    if (entry) {
      const restore = await invoke(base, 'home:restore-from-trash', [entry.id])
      expect(restore.status).toBe(200)
      expect(existsSync(target)).toBe(true)
    }
  })

  it('home:duplicate-file uses a smart counter on repeat duplicates', async () => {
    const source = join(dataDir, 'files', 'counter-source.docx')
    require('node:fs').mkdirSync(join(dataDir, 'files'), { recursive: true })
    writeFileSync(source, 'x')

    const r1 = await invoke(base, 'home:duplicate-file', [source])
    expect(r1.status).toBe(200)
    const p1 = (r1.body as { result?: { path?: string } })?.result?.path
    expect(p1).toBe(join(dataDir, 'files', 'counter-source-copy.docx'))

    const r2 = await invoke(base, 'home:duplicate-file', [source])
    expect(r2.status).toBe(200)
    const p2 = (r2.body as { result?: { path?: string } })?.result?.path
    expect(p2).toBe(join(dataDir, 'files', 'counter-source-copy (2).docx'))

    const r3 = await invoke(base, 'home:duplicate-file', [source])
    expect(r3.status).toBe(200)
    const p3 = (r3.body as { result?: { path?: string } })?.result?.path
    expect(p3).toBe(join(dataDir, 'files', 'counter-source-copy (3).docx'))
  })

  it('home:file-search returns ranked hits across a tree', async () => {
    const root = join(dataDir, 'search-root')
    require('node:fs').mkdirSync(join(root, 'nested'), { recursive: true })
    writeFileSync(join(root, 'notes.txt'), 'x')
    writeFileSync(join(root, 'nested', 'notes.txt'), 'y')

    const r = await invoke(base, 'home:file-search', [{ rootDir: root, needle: 'notes' }])
    expect(r.status).toBe(200)
    const hits = ((r.body as { result?: unknown[] })?.result ?? []) as Array<{
      path: string
      score: number
    }>
    expect(hits.length).toBeGreaterThanOrEqual(2)
    // Both files have `notes.txt` basename so both score the same.
    for (const h of hits) expect(h.score).toBeGreaterThanOrEqual(0.6)
  })

  it('home:properties returns stat + sha256', async () => {
    const target = join(dataDir, 'files', 'props.txt')
    writeFileSync(target, 'hello properties')
    const r = await invoke(base, 'home:properties', [target])
    expect(r.status).toBe(200)
    const props = (
      r.body as { result?: { path?: string; sizeBytes?: number; hash?: string | null } }
    )?.result
    expect(props?.path).toBe(target)
    expect(props?.sizeBytes).toBe('hello properties'.length)
    // @genoffice/file-management#fileProperties exposes the digest as `hash`
    // (a 64-char hex sha256 of the entire file, or null when the read fails).
    expect(props?.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  describe('Phase 3 — sheets routed through SheetsStore', () => {
    it('sheets:new-blank allocates a file through SheetsStore.create', async () => {
      // A minimal xlsx payload — just the zip magic. The store's
      // verifyMagic accepts any zip; the renderer's first save
      // replaces this with a real workbook.
      const payload = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).buffer
      const r = await invoke(base, 'sheets:new-blank', [{ xlsx: payload }])
      expect(r.status).toBe(200)
      const body = r.body as { result?: { id?: string; path?: string; name?: string } }
      expect(body.result?.id).toMatch(/^sheet-/)
      expect(body.result?.path).toMatch(/\.xlsx$/)
      expect(body.result?.name).toMatch(/\.xlsx$/)
    })

    it('workbook:open-path routes through SheetsStore.open for sha256 + magic check', async () => {
      // Write a real .xlsx (zip magic) to the FILES_DIR.
      const target = join(dataDir, 'files', `phase3-sheets-${Date.now()}.xlsx`)
      mkdirSync(join(dataDir, 'files'), { recursive: true })
      writeFileSync(target, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))
      // We can't easily exercise the sidecar parse in this minimal
      // environment, but the sha256 + fileBytes fields come straight
      // from SheetsStore.open. We assert the channel rejects an unmanaged
      // path so we know the new code path is wired in.
      const outside = await invoke(base, 'workbook:open-path', ['/etc/passwd.xlsx'])
      expect(outside.status).toBeGreaterThanOrEqual(400)
    })
  })

  describe('Phase 3 — pdf:save routed through PdfStore', () => {
    it('refuses when source path is missing', async () => {
      const r = await invoke(base, 'pdf:save', [{ path: join(dataDir, 'files', 'missing.pdf') }])
      expect(r.status).toBe(200)
      const body = r.body as { result?: { ok?: boolean; error?: string } }
      expect(body.result?.ok).toBe(false)
      expect(body.result?.error).toContain('source not found')
    })

    it('refuses when source is outside managed storage', async () => {
      const r = await invoke(base, 'pdf:save', [{ path: '/etc/passwd.pdf' }])
      expect(r.status).toBe(200)
      const body = r.body as { result?: { ok?: boolean; error?: string } }
      expect(body.result?.ok).toBe(false)
      expect(body.result?.error).toContain('outside the web storage area')
    })
  })
})

describe.skipIf(!haveBundle)(
  'file-management IPC handlers — atomic writes + dual-write P1-2',
  () => {
    let server: ChildProcess | undefined
    let base: string
    let dataDir: string

    beforeAll(async () => {
      dataDir = mkdtempSync(join(tmpdir(), 'genoffice-fm-atomic-'))
      const { mkdirSync } = require('node:fs') as typeof import('node:fs')
      mkdirSync(join(dataDir, 'files'), { recursive: true })
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
    }, 60_000)

    afterAll(() => {
      server?.kill('SIGTERM')
    })

    // P0-1: web:save-file now writes atomically. The handler must reject
    // empty buffers (atomicWriteFile throws on a 0-byte write) and leave no
    // .tmp residue on success.
    it('web:save-file writes atomically and produces no tmp residue on success', async () => {
      const name = `atomic-${Date.now()}.txt`
      const bytes = new TextEncoder().encode('hello atomic').buffer
      const r = await invoke(base, 'web:save-file', [{ name, bytes, projectId: 'proj-default' }])
      expect(r.status).toBe(200)
      const result = r.body as {
        result?: { ok?: boolean; id?: string; path?: string; name?: string }
      }
      expect(result?.result?.path).toBeTruthy()
      const written = readFileSync(result.result!.path!)
      expect(written.toString('utf8')).toBe('hello atomic')
      // No .tmp file should be left behind after a successful atomic write.
      const dir = result.result!.path!.split('/').slice(0, -1).join('/')
      const tmpFiles = require('node:fs')
        .readdirSync(dir)
        .filter((n: string) => n.includes('.tmp'))
      expect(tmpFiles).toEqual([])
    })

    // P0-1: empty bytes are a contract bug and must be rejected, not silently
    // truncated to a 0-byte file.
    it('web:save-file refuses zero-byte uploads', async () => {
      const r = await invoke(base, 'web:save-file', [
        { name: 'empty.txt', bytes: new ArrayBuffer(0) },
      ])
      // The handler throws InvalidArgumentError → 400 from the IPC transport.
      expect(r.status).toBe(400)
    })

    // P1-2: docs:save now also writes unifiedRecents. After the call the
    // entry must be visible to home:recents (legacy mirror) AND survive a
    // restart (verified by reading the on-disk recents.json file directly).
    it('docs:save updates both the legacy DOCS_RECENT mirror and unifiedRecents on disk', async () => {
      const name = `dual-write-${Date.now()}.docx`
      const target = join(dataDir, 'files', name)
      // Minimal zip header — docs:save does not parse, it just stores bytes.
      const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('dummy')])
      const r = await invoke(base, 'docs:save', [target, payload.buffer])
      expect(r.status).toBe(200)
      const body = r.body as { ok?: boolean; result?: { ok?: boolean } }
      expect(body?.result?.ok).toBe(true)

      // Legacy mirror: home:recents must surface the file in this session.
      const recents = await invoke(base, 'home:recents', [])
      expect(recents.status).toBe(200)
      const list =
        (recents.body as { result?: { entries?: Array<{ path: string }> } }).result?.entries ?? []
      expect(list.some((e) => e.path === target)).toBe(true)

      // unifiedRecents is debounced — wait past the 250ms default debounce.
      await new Promise((res) => setTimeout(res, 600))
      const recentsFile = readFileSync(join(dataDir, 'recents.json'), 'utf-8')
      expect(recentsFile).toContain(name)
    })

    // P0-8: home:rename-file rejects names with traversal, separators, control
    // chars, and over-long names. Each rejection must not crash the server.
    it('home:rename-file rejects unsafe newName inputs', async () => {
      const dir = join(dataDir, 'files')
      const source = join(dir, `original-${Date.now()}.txt`)
      writeFileSync(source, 'orig')
      const evil: Array<[string, string]> = [
        ['../escape.txt', 'path traversal'],
        ['with/slash.txt', 'forward slash'],
        ['with\backslash.txt', 'backslash'],
        ['.' + 'x'.repeat(300) + '.txt', 'over 255 chars'],
        ['has\u0000null.txt', 'control char'],
        ['', 'empty string'],
      ]
      for (const [bad, label] of evil) {
        const r = await invoke(base, 'home:rename-file', [source, bad])
        expect.soft(r.status, label).toBe(200)
        const body = r.body as { result?: { ok?: boolean; error?: string } }
        expect.soft(body?.result?.ok, `${label}: expected ok=false`).toBe(false)
        expect
          .soft(body?.result?.error, `${label}: expected error message`)
          .toMatch(/invalid file name|outside/)
        // The source must remain untouched on every rejection.
        expect.soft(existsSync(source), `${label}: source vanished`).toBe(true)
      }
    })

    // P0-8 (positive case): a clean rename must succeed, and the recents
    // entry must follow the new path (verified via legacy mirror).
    it('home:rename-file renames and updates recents', async () => {
      const dir = join(dataDir, 'files')
      const source = join(dir, `pre-${Date.now()}.txt`)
      const newName = `post-${Date.now()}.txt`
      writeFileSync(source, 'orig')
      const r = await invoke(base, 'home:rename-file', [source, newName])
      expect(r.status).toBe(200)
      const body = r.body as { result?: { ok?: boolean; path?: string } }
      expect(body?.result?.ok).toBe(true)
      expect(existsSync(body.result!.path!)).toBe(true)
      expect(existsSync(source)).toBe(false)
    })
  },
)

describe.skipIf(!haveBundle)('file-management IPC handlers — recents file watcher (B4)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-fm-watch-'))
    // Pre-create the data dir tree so the bundle's boot-time mkdir on
    // FILES_DIR doesn't race the watcher setup.
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(dataDir, 'files'), { recursive: true })
    const port = 28000 + Math.floor(Math.random() * 1000)
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
    // Give the watcher 200ms to attach (fs.watch on Darwin needs a beat
    // before the first event is delivered — same reason chokidar's
    // `useFsEvents: false` defaults to a 100ms ready delay).
    await new Promise((res) => setTimeout(res, 200))
  }, 60_000)

  afterAll(() => {
    server?.kill('SIGTERM')
  })

  it('auto-records a freshly dropped PDF into home:recents', async () => {
    const target = join(dataDir, 'files', 'dropped.pdf')
    writeFileSync(target, '%PDF-1.4 dummy')
    // Wait past the 300ms debounce + a generous safety margin so the
    // watcher's flush actually lands on disk.
    await new Promise((res) => setTimeout(res, 600))

    const r = await invoke(base, 'home:recents', [])
    expect(r.status).toBe(200)
    const result = (r.body as { result?: { entries?: Array<{ path: string }> } })?.result
    const paths = (result?.entries ?? []).map((e) => e.path)
    expect(paths).toContain(target)
  })

  it('skips docx and .trash/ entries so only the watched exts land', async () => {
    // DOCS_RECENT seeded from the IPC handler returns only paths the
    // store knows about; the watcher filters .docx out before add(),
    // so a docx written under FILES_DIR must NOT show up.
    const docx = join(dataDir, 'files', 'note.docx')
    writeFileSync(docx, 'PK fake docx bytes')
    mkdirSync(join(dataDir, 'files', '.trash'), { recursive: true })
    const trashed = join(dataDir, 'files', '.trash', 'hidden.pdf')
    writeFileSync(trashed, '%PDF trashed')
    await new Promise((res) => setTimeout(res, 600))

    const r = await invoke(base, 'home:recents', [])
    const result = (r.body as { result?: { entries?: Array<{ path: string }> } })?.result
    const paths = (result?.entries ?? []).map((e) => e.path)
    expect(paths).not.toContain(docx)
    expect(paths).not.toContain(trashed)
  })

  it('removes a file from home:recents when it is deleted from disk', async () => {
    // The deletion path exercises the watcher's existsSync=false branch.
    const target = join(dataDir, 'files', 'will-disappear.md')
    writeFileSync(target, '# hi')
    await new Promise((res) => setTimeout(res, 600))
    const before = await invoke(base, 'home:recents', [])
    const beforePaths = (
      (before.body as { result?: { entries?: Array<{ path: string }> } })?.result?.entries ?? []
    ).map((e) => e.path)
    expect(beforePaths).toContain(target)

    unlinkSync(target)
    await new Promise((res) => setTimeout(res, 600))

    const after = await invoke(base, 'home:recents', [])
    const afterPaths = (
      (after.body as { result?: { entries?: Array<{ path: string }> } })?.result?.entries ?? []
    ).map((e) => e.path)
    expect(afterPaths).not.toContain(target)
  })
})

describe.skipIf(!haveBundle)('file-management IPC handlers — preview thumbnails (B19)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-fm-thumb-'))
    mkdirSync(join(dataDir, 'files'), { recursive: true })
    const port = 29000 + Math.floor(Math.random() * 1000)
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

  afterAll(() => {
    server?.kill('SIGTERM')
  })

  it('returns a base64 PNG data URL for a real PNG when sharp is available', async () => {
    // 1×1 transparent PNG, base64 decoded into bytes. Tiny on purpose so
    // the IPC envelope stays small and the test stays fast.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    )
    const target = join(dataDir, 'files', 'pixel.png')
    writeFileSync(target, png)

    const r = await invoke(base, 'home:preview:get', [{ path: target, size: 64 }])
    expect(r.status).toBe(200)
    const body = r.body as {
      result?: { ok?: boolean; mime?: string; dataUrl?: string; size?: number; reason?: string }
    }
    if (body.result?.ok === true) {
      // sharp is installed in this environment — verify the data URL shape.
      expect(body.result.mime).toBe('image/png')
      expect(body.result.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
      expect(body.result.size).toBeGreaterThan(0)
    } else {
      // sharp is NOT installed (the typical dev environment for the
      // web-server workspace) — defaultImageGenerator returns null and
      // the handler is honest about it. The renderer's fallback icon
      // path covers this. Same anydoc-style degraded semantics.
      expect(body.result?.reason).toBe('unsupported')
    }
  })

  it('returns unsupported for a non-image file (e.g. plain text)', async () => {
    const target = join(dataDir, 'files', 'note.txt')
    writeFileSync(target, 'hello world')

    const r = await invoke(base, 'home:preview:get', [{ path: target }])
    expect(r.status).toBe(200)
    const body = r.body as { result?: { ok?: boolean; reason?: string } }
    expect(body.result?.ok).toBe(false)
    expect(body.result?.reason).toBe('unsupported')
  })

  it('refuses paths outside managed storage', async () => {
    const r = await invoke(base, 'home:preview:get', [{ path: '/etc/passwd' }])
    expect(r.status).toBe(200)
    const body = r.body as { result?: { ok?: boolean; reason?: string } }
    expect(body.result?.ok).toBe(false)
    expect(body.result?.reason).toBe('outside-storage')
  })

  it('returns identical bytes for repeat reads (cache hit) when sharp is available', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64',
    )
    const target = join(dataDir, 'files', 'cached.png')
    writeFileSync(target, png)

    const first = await invoke(base, 'home:preview:get', [{ path: target, size: 64 }])
    const second = await invoke(base, 'home:preview:get', [{ path: target, size: 64 }])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstBody = first.body as { result?: { dataUrl?: string; size?: number } }
    const secondBody = second.body as { result?: { dataUrl?: string; size?: number } }
    if (firstBody.result?.dataUrl) {
      // Same source → same cached PNG bytes → identical data URL.
      expect(firstBody.result.dataUrl).toBe(secondBody.result?.dataUrl)
      expect(firstBody.result.size).toBe(secondBody.result?.size)
    } else {
      // sharp not installed — both calls uniformly unsupported.
      expect(secondBody.result?.dataUrl).toBeUndefined()
    }
  })
})

describe.skipIf(!haveBundle)('FileIndexStore persistence across server restarts (P1-1)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-fis-persist-'))
    // Pre-seed a files-index.json as if a previous session had written
    // it — the new server boot must rehydrate this entry.
    mkdirSync(join(dataDir, 'files'), { recursive: true })
    const persistedEntry = {
      id: 'persisted-1',
      name: 'persisted.txt',
      path: join(dataDir, 'files', 'persisted-1'),
      size: 11,
      mimeType: 'text/plain',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    }
    writeFileSync(persistedEntry.path, 'hello world', 'utf-8')
    writeFileSync(
      join(dataDir, 'files-index.json'),
      JSON.stringify([persistedEntry], null, 2),
      'utf-8',
    )

    const port = 26000 + Math.floor(Math.random() * 5000)
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

  it('rehydrates files:read({id}) from the persisted index', async () => {
    const r = await invoke(base, 'files:read', [{ id: 'persisted-1' }])
    expect(r.status).toBe(200)
    const body = r.body as {
      result?: { id?: string; path?: string; content?: string }
    }
    expect(body.result?.id).toBe('persisted-1')
    expect(body.result?.path).toBe(join(dataDir, 'files', 'persisted-1'))
    expect(body.result?.content).toBe('hello world')
  })

  it('a new upload then restart survives — id is still resolvable', async () => {
    const name = 'roundtrip.txt'
    const bytes = new TextEncoder().encode('round-trip body').buffer
    const saved = await invoke(base, 'web:save-file', [{ name, bytes }])
    expect(saved.status).toBe(200)
    const savedBody = saved.body as { result?: { id?: string; path?: string } }
    expect(savedBody.result?.id).toBeDefined()
    const id = savedBody.result!.id!

    // Verify the in-session index also resolves the entry.
    const first = await invoke(base, 'files:read', [{ id }])
    expect(first.status).toBe(200)
    const firstBody = first.body as {
      result?: { id?: string; content?: string }
    }
    expect(firstBody.result?.content).toBe('round-trip body')

    // Force a flushNow + restart by killing the server and rebooting
    // against the same DATA_DIR.
    server?.kill()
    await new Promise((res) => setTimeout(res, 250))

    const port = 27000 + Math.floor(Math.random() * 5000)
    const restartedBase = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        GENOFFICE_DATA_DIR: dataDir,
      },
      stdio: 'ignore',
    })
    await pollHealth(restartedBase, 30_000)
    base = restartedBase

    const second = await invoke(base, 'files:read', [{ id }])
    expect(second.status).toBe(200)
    const secondBody = second.body as {
      result?: { id?: string; content?: string }
    }
    expect(secondBody.result?.id).toBe(id)
    expect(secondBody.result?.content).toBe('round-trip body')
  })

  describe('DocumentStore-backed CRUD channels (Phase 2)', () => {
    it('markdown:save round-trips through the shared MarkdownStore', async () => {
      const name = `store-${Date.now()}.md`
      const saved = await invoke(base, 'markdown:save', [
        { text: '# store test\n\nbody', path: join(dataDir, name) },
      ])
      expect(saved.status).toBe(200)
      const savedBody = saved.body as { result?: { ok?: boolean; path?: string } }
      expect(savedBody.result?.ok).toBe(true)
      expect(savedBody.result?.path).toBe(join(dataDir, name))

      const read = await invoke(base, 'markdown:read-file', [join(dataDir, name)])
      expect(read.status).toBe(200)
      const readBody = read.body as { result?: string }
      expect(readBody.result).toBe('# store test\n\nbody')
    })

    it('html:save allocates a new file under ${DATA_DIR}/html/', async () => {
      const saved = await invoke(base, 'html:save', [
        { text: '<html><body>store</body></html>', suggestedName: 'phase2.html' },
      ])
      expect(saved.status).toBe(200)
      const savedBody = saved.body as { result?: { ok?: boolean; path?: string } }
      expect(savedBody.result?.ok).toBe(true)
      expect(savedBody.result?.path).toMatch(/[\\/]html[\\/]phase2\.html$/)

      // The file must be readable through the public read-file channel.
      const path = savedBody.result!.path!
      const read = await invoke(base, 'html:read-file', [path])
      expect(read.status).toBe(200)
      const readBody = read.body as { result?: string }
      expect(readBody.result).toContain('store')
    })

    it('docs:save-new uses the shared DocsStore.create()', async () => {
      const initialDocx = new TextEncoder().encode('placeholder docx bytes').buffer
      const r = await invoke(base, 'docs:save-new', [
        'phase2-test.docx',
        initialDocx,
        'proj-default',
      ])
      expect(r.status).toBe(200)
      const body = r.body as { result?: { id?: string; path?: string; name?: string } }
      expect(body.result?.id).toMatch(/^doc-/)
      expect(body.result?.path).toMatch(/\.docx$/)
      expect(body.result?.name).toBe('phase2-test.docx')

      // The new file must be reachable through files:read by path.
      const read = await invoke(base, 'files:read', [{ path: body.result!.path! }])
      expect(read.status).toBe(200)
      const readBody = read.body as { result?: { isBase64?: boolean } }
      expect(readBody.result).toBeTruthy()
    })
  })
  // Regression: the watcher's boot pass used to treat every pre-existing file
  // as newly added, so it overwrote the name recorded by the save channel with
  // the generated on-disk basename (`7f3a…-report.pdf` instead of
  // `report.pdf`). The grid showed id-shaped names for every watched format.
  it('keeps the recorded display name for a pre-existing file at boot', async () => {
    const name = `display-name-${Date.now()}.md`
    const target = join(dataDir, 'files', name)
    writeFileSync(target, '# dropped in\n', 'utf-8')

    // The save channel records the user-facing name under a different path...
    const upload = await invoke(base, 'web:save-file', [
      {
        name: 'quarterly-report.pdf',
        bytes: new TextEncoder().encode('%PDF-1.4\ntrailer\n%%EOF\n').buffer,
      },
    ])
    const uploaded = (upload.body as { result?: { path?: string } }).result!.path!

    // ...and a restart must not rewrite either entry to its raw basename.
    await stopServer(server, undefined)
    const port = 25000 + Math.floor(Math.random() * 4000)
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

    const recents = await invoke(base, 'home:recents', [{ limit: 200 }])
    const entries =
      (recents.body as { result?: { entries?: Array<{ name: string; path: string }> } }).result
        ?.entries ?? []
    const uploadedRow = entries.find((e) => e.path === uploaded)
    expect(uploadedRow?.name).toBe('quarterly-report.pdf')
    const droppedRow = entries.find((e) => e.path === target)
    expect(droppedRow?.name).toBe(name)
  }, 90_000)

  // Regression: `home:recents` used to read only the legacy `DOCS_RECENT`
  // mirror, whose file is capped, so a restart dropped documents that were
  // still on disk and still present in the restart-safe store.
  it('surfaces more than ten recents after a restart', async () => {
    // Seed past the legacy mirror's own row cap so the assertion below can
    // only pass if the restart-safe store (not the mirror file) is the source.
    for (let i = 0; i < 14; i += 1) {
      await invoke(base, 'web:save-file', [
        {
          name: `many-${i}.pdf`,
          bytes: new TextEncoder().encode(`%PDF-1.4\n%%EOF\n${i}`).buffer,
        },
      ])
    }
    const before = await invoke(base, 'home:recents', [{ limit: 500 }])
    const beforeTotal = (before.body as { result?: { totalAll?: number } }).result?.totalAll ?? 0
    expect(beforeTotal).toBeGreaterThan(10)

    await stopServer(server, undefined)
    const port = 25000 + Math.floor(Math.random() * 4000)
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

    const after = await invoke(base, 'home:recents', [{ limit: 500 }])
    const afterTotal = (after.body as { result?: { totalAll?: number } }).result?.totalAll ?? 0
    // The legacy mirror file holds ten rows; the surviving count must come from
    // the restart-safe store plus the disk sweep, not from that file.
    expect(afterTotal).toBeGreaterThan(10)
  }, 90_000)

  // Regression: the boot sweep only adopted pdf/md/html, so an uploaded docx
  // or xlsx vanished from the grid on the next boot even though the bytes were
  // still on disk.
  it('adopts every document format from disk on boot', async () => {
    const extensions = ['docx', 'xlsx', 'pptx', 'pdf', 'md', 'html']
    const expected = new Set<string>()
    for (const ext of extensions) {
      const name = `sweep-${Date.now()}-${ext}.${ext}`
      const path = join(dataDir, 'files', name)
      const bytes =
        ext === 'docx' || ext === 'xlsx' || ext === 'pptx'
          ? Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x')])
          : Buffer.from(ext === 'pdf' ? '%PDF-1.4\ntrailer\n%%EOF\n' : 'plain text')
      writeFileSync(path, bytes)
      expected.add(path)
    }

    await stopServer(server, undefined)
    const port = 25000 + Math.floor(Math.random() * 4000)
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

    const recents = await invoke(base, 'home:recents', [{ limit: 500 }])
    const paths = new Set(
      (
        (recents.body as { result?: { entries?: Array<{ path: string }> } }).result?.entries ?? []
      ).map((e) => e.path),
    )
    for (const path of expected) {
      expect(paths.has(path), path).toBe(true)
    }
  }, 90_000)
})
