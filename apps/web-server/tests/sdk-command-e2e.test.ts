/**
 * End-to-end proof for the §11.36 SDK command path.
 *
 * The unit suite (`sdk-command-dispatch.test.ts`) exercises
 * `dispatchSdkCommand()` in-process; the bridge suite
 * (`embed-bridge.test.ts`) exercises the iframe's fetch/POST shape
 * against a mocked fetch. Neither proves the REAL chain works:
 *
 *   HTTP POST /api/ipc/sdk:command
 *     → index.ts IPC dispatcher
 *     → registry.getHandler('sdk:command')
 *     → dispatchSdkCommand
 *     → durable store write
 *     → JSON envelope on the wire
 *     → (re-query proves persistence)
 *
 * This suite boots the real bundled server on a random port with an
 * isolated DATA_DIR and drives it over HTTP exactly as the embed
 * bridge does, so a regression anywhere in that chain fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

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

/**
 * Drive the sdk:command channel the way the embed bridge does:
 * `{args:[{name, args, docId}]}` + `x-ipc-session`.
 */
async function sdkCommand(
  base: string,
  envelope: { name: string; args?: unknown; docId?: string },
  session = 'embed-e2e',
): Promise<{ status: number; ok?: boolean; result?: unknown; error?: { code: string; message: string } }> {
  const response = await fetch(`${base}/api/ipc/${encodeURIComponent('sdk:command')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': session },
    body: JSON.stringify({ args: [envelope] }),
  })
  const text = await response.text()
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null
  // The IPC wire shape is `{ok:true, result}` on success and
  // `{error:{code, channel, reason}}` (no `ok` field) on failure —
  // mirror that into one convenient object for the assertions.
  const hasError = Boolean(parsed && (parsed as { error?: unknown }).error)
  return {
    status: response.status,
    ok: hasError ? false : Boolean(parsed && parsed.ok === true),
    ...(parsed && 'result' in parsed ? { result: parsed.result } : {}),
    ...(hasError ? { error: (parsed as { error: { code: string; message: string } }).error } : {}),
  }
}

describe.skipIf(skip)('SDK command channel e2e (sdk1.md §11.36)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  const docName = 'e2e-doc.docx'

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-sdkcmd-'))
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(join(filesDir, docName), 'seed-v1')
    const port = 34000 + Math.floor(Math.random() * 2000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 20_000)
  }, 30_000)

  afterAll(async () => {
    await stopServer(server)
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('routes sdk:command through the real IPC dispatcher', async () => {
    const res = await sdkCommand(base, { name: 'listComments', args: {}, docId: docName })
    expect(res.status).toBe(200)
    expect(res.ok).toBe(true)
    expect((res.result as { comments: unknown[] }).comments).toEqual([])
  })

  it('addComment persists and is visible to a later listComments over HTTP', async () => {
    const added = await sdkCommand(base, {
      name: 'addComment',
      args: { text: 'hello from e2e', anchor: { cell: 'C3' } },
      docId: docName,
    })
    expect(added.ok).toBe(true)
    const id = (added.result as { id: string }).id
    expect(id).toMatch(/^cm_/)

    const listed = await sdkCommand(base, { name: 'listComments', args: {}, docId: docName })
    const comments = (listed.result as { comments: Array<{ id: string; text: string; anchor: unknown }> }).comments
    expect(comments).toHaveLength(1)
    expect(comments[0]!.id).toBe(id)
    expect(comments[0]!.text).toBe('hello from e2e')
    expect(comments[0]!.anchor).toEqual({ cell: 'C3' })
  })

  it('createSnapshot + listVersions round-trip over HTTP', async () => {
    const snap = await sdkCommand(base, { name: 'createSnapshot', args: { label: 'e2e point' }, docId: docName })
    expect(snap.ok).toBe(true)
    // captureBeforeSave returns `v-<docId>-<idx>-<rand>`; listVersions
    // reports the canonical `v-<docId>-<idx>`. Compare on the numeric
    // index rather than the raw ids.
    const snapId = (snap.result as { id: string }).id
    const snapIdx = Number(/\.docx-(\d+)/.exec(snapId)![1])

    const listed = await sdkCommand(base, { name: 'listVersions', args: {}, docId: docName })
    const versions = (listed.result as { versions: Array<{ id: string; index: number; message?: string }> }).versions
    const match = versions.find((v) => v.index === snapIdx)
    expect(match).toBeDefined()
    expect(match!.message).toBe('e2e point')
  })

  it('restoreVersion rewrites the live file on disk', async () => {
    const livePath = join(dataDir, 'files', docName)
    const snap = await sdkCommand(base, { name: 'createSnapshot', args: {}, docId: docName })
    const versionId = (snap.result as { id: string }).id
    // Mutate the live file behind the server's back.
    writeFileSync(livePath, 'mutated-after-snapshot')
    const restored = await sdkCommand(base, { name: 'restoreVersion', args: { versionId }, docId: docName })
    expect(restored.ok).toBe(true)
    expect(readFileSync(livePath, 'utf8')).toBe('seed-v1')
  })

  it('reportUsage is accepted and surfaces on /api/v1/metrics', async () => {
    const report = await sdkCommand(base, {
      name: 'reportUsage',
      args: { instanceId: 'e2e-inst', docBytesWritten: 99, aiCalls: 1, sessionDurationMs: 250 },
      docId: docName,
    })
    expect(report.ok).toBe(true)
    const metrics = await fetch(`${base}/api/v1/metrics`)
    const body = await metrics.text()
    expect(body).toMatch(/^genoffice_sdk_usage_samples_total \d+$/m)
    expect(body).toMatch(/^genoffice_sdk_doc_bytes_written_total 99$/m)
    expect(body).toMatch(/^genoffice_sdk_ai_calls_total 1$/m)
  })

  it('rejects a renderer-owned command with a structured WEB_UNSUPPORTED', async () => {
    const res = await sdkCommand(base, { name: 'setContent', args: { content: 'x' }, docId: docName })
    expect(res.status).toBe(501)
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('WEB_UNSUPPORTED')
  })

  it('rejects an unknown command with a structured WEB_UNSUPPORTED', async () => {
    const res = await sdkCommand(base, { name: 'notARealCommand', args: {}, docId: docName })
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('WEB_UNSUPPORTED')
  })

  it('rejects a traversal docId without touching the filesystem', async () => {
    const res = await sdkCommand(base, { name: 'listComments', args: {}, docId: '../../etc/passwd' })
    expect(res.ok).toBe(false)
    expect(res.error!.code).toBe('INVALID_ARGUMENT')
  })
})
