import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startUiHost, type UiHostHandle } from '../src/ui/host'
import { readDocument } from '../src/documents'

const DOCS_RENDERER_DIR = fileURLToPath(new URL('../../../apps/docs/out/renderer', import.meta.url))
const FIXTURE_DOCX = fileURLToPath(
  new URL('../../../apps/docs/tests/encrypted-fixtures/office-agile-plain.docx', import.meta.url),
)

let host: UiHostHandle | null = null

async function bootHost(): Promise<UiHostHandle> {
  const { mkdtempSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'office-ai-docs-'))
  symlinkSync(DOCS_RENDERER_DIR, join(root, 'docs'), 'dir')
  host = await startUiHost({ assetsDir: root })
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function invoke(channel: string, args: unknown[] = []): Promise<{ status: number; body: any }> {
  const response = await fetch(`${host!.url}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': 'docs-session' },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

function encodeBytes(bytes: Uint8Array): { __ipcBytes: string; b64: string } {
  return { __ipcBytes: 'u8', b64: Buffer.from(bytes).toString('base64') }
}

describe('docs handlers (M1)', () => {
  it('stages bytes and opens them through docs:open-path', async () => {
    const h = await bootHost()
    const bytes = new Uint8Array(readFileSync(FIXTURE_DOCX))
    const staged = h.open('docs', bytes, { name: 'office-agile-plain.docx' })

    expect(staged.url).toContain('/docs?open=')
    const opened = await invoke('docs:open-path', [staged.path])
    expect(opened.status).toBe(200)
    expect(opened.body.result.name).toBe('office-agile-plain.docx')
    expect(opened.body.result.encrypted).toBe(false)
    expect(typeof opened.body.result.hash).toBe('string')
    expect(opened.body.result.hash).toHaveLength(64)
  })

  it('returns needsPassword for an encrypted docx', async () => {
    const h = await bootHost()
    const { readFileSync: read } = await import('node:fs')
    const encrypted = new Uint8Array(
      read(fileURLToPath(new URL('../../../apps/docs/tests/encrypted-fixtures/office-agile-password.docx', import.meta.url))),
    )
    const staged = h.open('docs', encrypted, { name: 'secret.docx' })
    const opened = await invoke('docs:open-path', [staged.path])
    expect(opened.body.result.needsPassword).toBe(true)
  })

  it('saves renderer bytes and reads them back with the edit applied', async () => {
    const h = await bootHost()
    const original = new Uint8Array(readFileSync(FIXTURE_DOCX))
    const staged = h.open('docs', original, { name: 'doc.docx' })

    // Simulate the renderer's save: the docx bytes it serialized (here the
    // fixture itself) go back through docs:save.
    const result = await invoke('docs:save', [staged.path, encodeBytes(original)])
    expect(result.status).toBe(200)
    expect(result.body.result.ok).toBe(true)

    const readBack = h.readFile(staged.path)
    expect(readBack.byteLength).toBe(original.byteLength)
    const doc = await readDocument(readBack)
    expect(doc.kind).toBe('docx')
  })

  it('rejects paths outside the workspace', async () => {
    const h = await bootHost()
    const escaped = await invoke('docs:open-path', ['/etc/hosts'])
    expect(escaped.status).toBe(400)
    expect(escaped.body.error.code).toBe('OFFICE_BAD_INPUT')
  })

  it('persists docs:save-new under the workspace files dir and lists it in docs:recent', async () => {
    const h = await bootHost()
    const bytes = new Uint8Array(readFileSync(FIXTURE_DOCX))
    const saved = await invoke('docs:save-new', ['Quarterly Report.docx', encodeBytes(bytes)])
    expect(saved.body.result.ok).toBe(true)
    expect(saved.body.result.path).toContain(h.context.workspace.filesDir)

    const recent = await invoke('docs:recent')
    expect(recent.body.result.some((row: { path: string }) => row.path === saved.body.result.path)).toBe(true)
  })

  it('round-trips bytes through web:write-temp-file and web:read-file-bytes', async () => {
    const h = await bootHost()
    const payload = new Uint8Array([1, 2, 3, 250])
    const written = await invoke('web:write-temp-file', [{ name: 'blob.bin', bytes: encodeBytes(payload) }])
    expect(written.status).toBe(200)
    const path = written.body.result as string
    const read = await invoke('web:read-file-bytes', [path])
    const wire = read.body.result.bytes as { __ipcBytes: string; b64: string }
    expect(wire.__ipcBytes).toBe('ab')
    expect(Array.from(Buffer.from(wire.b64, 'base64'))).toEqual([1, 2, 3, 250])
  })

  it('answers docs list channels so the ribbon can enumerate recent documents', async () => {
    const h = await bootHost()
    expect((await invoke('docs:recent')).body.result).toEqual([])
    expect((await invoke('docs:get-settings')).body.result.language).toBe('zh-CN')
    expect((await invoke('docs:font-metrics', ['Arial'])).body.result.unitsPerEm).toBe(1000)
  })
})
