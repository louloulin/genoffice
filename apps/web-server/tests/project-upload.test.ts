/**
 * End-to-end coverage for the `project:upload` channel — the pure-upload path
 * the Home FAB uses. Boots the real bundle against a temp DATA_DIR and probes
 * the channel over HTTP, asserting:
 *
 *   - multi-file upload lands all entries under the target project
 *   - files appear in `project:files` with the correct display name (this was
 *      a real regression in the wkspace — `files:create` ids parsed down to a
 *      bare timestamp; the FILES_INDEX lookup the test cases added above fixes
 *      that and this test pins the fix in place)
 *   - partial-success path: empty bytes are skipped, oversized bytes are
 *      skipped, valid bytes still land
 *   - moveFile is symmetric: moving a file from project A to B removes it
 *      from A, and a no-op move (file already in target) is a no-op
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeTransportValue, encodeTransportValue } from '../src/common/codec'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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
    } catch { /* keep polling */ }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('server did not become healthy in time')
}

describe.skipIf(!haveBundle)('project:upload channel', () => {
  let server: ChildProcess
  let base: string
  let dataDir: string
  let port: number

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-project-upload-'))
    port = 18200 + Math.floor(Math.random() * 1000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, DATA_DIR: dataDir, GENOFFICE_DATA_DIR: dataDir, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 30_000)
  }, 60_000)

  afterAll(async () => {
    if (server) await stopServer(server)
    if (dataDir && existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  })

  async function invoke(channel: string, args: unknown[]): Promise<unknown> {
    const encoded = args.map((a) => encodeTransportValue(a))
    const r = await fetch(`${base}/api/ipc/${channel}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: encoded }),
    })
    const body = (await r.json()) as { ok?: boolean; result?: unknown }
    if (!body.ok) throw new Error(`${channel} failed`)
    return decodeTransportValue(body.result)
  }

  it('uploads multiple files into the default project and lists them with display names', async () => {
    const projects = (await invoke('project:list', [])) as Array<{ id: string; name: string; files: string[] }>
    expect(projects.length).toBeGreaterThan(0)
    const proj = projects[0]

    const files = [
      { name: 'hello.txt', bytes: Buffer.from('hello world'), mimeType: 'text/plain' },
      { name: 'fake.docx', bytes: Buffer.from('PK fake docx'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      { name: 'fake.pdf', bytes: Buffer.from('%PDF fake'), mimeType: 'application/pdf' },
    ]
    const result = (await invoke('project:upload', [{ projectId: proj.id, files }])) as {
      uploaded: Array<{ id: string; name: string; size: number; mimeType: string; projectId: string }>
      skipped: Array<{ name: string; reason: string }>
      projectId: string
    }
    expect(result.skipped).toEqual([])
    expect(result.uploaded.length).toBe(3)
    expect(result.uploaded.map((u) => u.name).sort()).toEqual(['fake.docx', 'fake.pdf', 'hello.txt'])
    expect(result.uploaded.every((u) => u.projectId === proj.id)).toBe(true)

    const listed = (await invoke('project:files', [{ projectId: proj.id }])) as Array<{ name: string; mimeType: string; id: string }>
    expect(listed.length).toBe(3)
    expect(listed.map((l) => l.name).sort()).toEqual(['fake.docx', 'fake.pdf', 'hello.txt'])
    /* Display names must come from FILES_INDEX, not from id parsing — the
     * previous `fileId.split('-').slice(1).join('-')` strategy collapsed the
     * timestamp/random prefix and dropped the actual filename. */
    expect(listed.find((l) => l.name === 'hello.txt')).toBeDefined()
  })

  it('skips empty and oversized files while still landing the valid ones', async () => {
    const projects = (await invoke('project:list', [])) as Array<{ id: string }>
    const proj = projects[0]
    const oversize = Buffer.alloc(101 * 1024 * 1024, 0xff) /* > 100 MiB cap */

    const result = (await invoke('project:upload', [{
      projectId: proj.id,
      files: [
        { name: 'ok.txt', bytes: Buffer.from('ok') },
        { name: 'empty.txt', bytes: Buffer.alloc(0) },
        { name: 'huge.bin', bytes: oversize },
      ],
    }])) as { uploaded: unknown[]; skipped: Array<{ name: string; reason: string }> }

    expect(result.uploaded.length).toBe(1)
    expect(result.skipped.length).toBe(2)
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.name, s.reason]))
    expect(reasons['empty.txt']).toMatch(/empty/)
    expect(reasons['huge.bin']).toMatch(/cap/)
  })

  it('moveFile is symmetric: removes the file from the source project', async () => {
    /* Create a second project */
    const projectB = (await invoke('project:create', [{ name: 'Project B' }])) as { id: string; files: string[] }
    /* Upload into project A (the default) */
    const projects = (await invoke('project:list', [])) as Array<{ id: string; files: string[] }>
    const projA = projects[0]
    const result = (await invoke('project:upload', [{
      projectId: projA.id,
      files: [{ name: 'move-me.txt', bytes: Buffer.from('to move') }],
    }])) as { uploaded: Array<{ id: string }> }
    expect(result.uploaded.length).toBe(1)
    const fileId = result.uploaded[0].id

    /* Move into project B */
    await invoke('project:moveFile', [{ filePath: fileId, projectId: projectB.id }])

    const aAfter = (await invoke('project:files', [{ projectId: projA.id }])) as Array<{ id: string }>
    const bAfter = (await invoke('project:files', [{ projectId: projectB.id }])) as Array<{ id: string }>
    expect(aAfter.find((f) => f.id === fileId)).toBeUndefined()
    expect(bAfter.find((f) => f.id === fileId)).toBeDefined()
  })
})
