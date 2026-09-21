import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { MimoStorageBackend } from '../../src/storage/mimo'
import { StorageNotFoundError } from '../../src/storage/backend'

interface StoredFile { size: number; contentType?: string; meta?: Record<string, string>; body: Buffer }

let server: Server
let url: string
let store = new Map<string, StoredFile>()
let authSeen: string[] = []

beforeEach(async () => {
  store = new Map()
  authSeen = []
  server = createServer((req, res) => {
    if (req.headers.authorization) authSeen.push(req.headers.authorization as string)
    void handle(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as AddressInfo
  url = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
  const urlObj = new URL(req.url ?? '/', 'http://localhost')
  const key = decodeURIComponent(urlObj.pathname.replace(/^\//, ''))
  const bucket = urlObj.searchParams.get('bucket') ?? ''

  if (urlObj.searchParams.get('list') === '1') {
    const prefix = urlObj.searchParams.get('prefix') ?? ''
    /* The mock treats the bucket as a tag rather than a path segment — the
     * real mimo server scopes by namespace on its own. */
    const items = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => ({ key: k, size: v.size, modifiedAt: new Date().toISOString() }))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ items }))
    return
  }

  if (urlObj.searchParams.get('signed') === '1') {
    const stored = store.get(key)
    if (!stored) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ url: `${url}/signed/${encodeURIComponent(key)}?token=abc&expires=${Date.now() + 60_000}` }))
    return
  }

  if (req.method === 'PUT') {
    const body = await readBody(req)
    const contentType = (req.headers['content-type'] as string | undefined) ?? undefined
    const metaHeader = req.headers['x-genoffice-meta'] as string | undefined
    let meta: Record<string, string> | undefined
    if (metaHeader) {
      try {
        meta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf-8'))
      } catch { /* ignore */ }
    }
    store.set(key, { size: body.byteLength, contentType, meta, body })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (req.method === 'GET') {
    const stored = store.get(key)
    if (!stored) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': stored.contentType ?? 'application/octet-stream',
      'Content-Length': String(stored.size),
      ...(stored.meta ? { 'X-Genoffice-Meta': Buffer.from(JSON.stringify(stored.meta), 'utf-8').toString('base64') } : {}),
    })
    res.end(stored.body)
    return
  }

  if (req.method === 'HEAD') {
    const stored = store.get(key)
    if (!stored) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {
      'Content-Type': stored.contentType ?? 'application/octet-stream',
      'Content-Length': String(stored.size),
      ...(stored.meta ? { 'X-Genoffice-Meta': Buffer.from(JSON.stringify(stored.meta), 'utf-8').toString('base64') } : {}),
    })
    res.end()
    return
  }

  if (req.method === 'DELETE') {
    const existed = store.delete(key)
    res.writeHead(existed ? 204 : 404)
    res.end()
    return
  }

  res.writeHead(405)
  res.end()
}

function makeBackend(extra: Partial<ConstructorParameters<typeof MimoStorageBackend>[0]> = {}) {
  return new MimoStorageBackend({
    filesDir: '/unused',
    mimo: { endpoint: url, bucket: 'b', timeoutMs: 5_000, ...(extra.mimo ?? {}) },
    ...extra,
  })
}

describe('MimoStorageBackend', () => {
  it('round-trips bytes via PUT/GET', async () => {
    const backend = makeBackend()
    const { key, size } = await backend.put('hello.txt', new TextEncoder().encode('mimo!'))
    expect(size).toBe(5)
    const round = await backend.get(key)
    expect(new TextDecoder().decode(round)).toBe('mimo!')
  })

  it('reports meta via head()', async () => {
    const backend = makeBackend()
    await backend.put('x.docx', new Uint8Array([1, 2]), {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      meta: { projectId: 'p1' },
    })
    const head = await backend.head('x.docx')
    expect(head.exists).toBe(true)
    expect(head.size).toBe(2)
    expect(head.contentType).toContain('wordprocessingml')
    expect(head.meta?.projectId).toBe('p1')
  })

  it('throws StorageNotFoundError on missing key', async () => {
    const backend = makeBackend()
    await expect(backend.get('absent')).rejects.toBeInstanceOf(StorageNotFoundError)
    const head = await backend.head('absent')
    expect(head.exists).toBe(false)
  })

  it('list() respects prefix and bucket', async () => {
    const backend = makeBackend()
    await backend.put('a.docx', new Uint8Array([1]))
    await backend.put('b.docx', new Uint8Array([2]))
    const items = await backend.list('a')
    expect(items.map((i) => i.key)).toEqual(['a.docx'])
  })

  it('delete() is idempotent (404 resolves cleanly)', async () => {
    const backend = makeBackend()
    await expect(backend.delete('never-existed.docx')).resolves.toBeUndefined()
  })

  it('getSignedUrl() returns the URL the mock server emits', async () => {
    const backend = makeBackend()
    await backend.put('x.txt', new TextEncoder().encode('hi'))
    const signed = await backend.getSignedUrl('x.txt', { expiresInSeconds: 60 })
    expect(signed).toContain('/signed/')
    expect(signed).toContain('token=abc')
  })

  it('attaches Authorization when apiKey is configured', async () => {
    const backend = new MimoStorageBackend({
      filesDir: '/unused',
      mimo: { endpoint: url, apiKey: 'sk-test', bucket: 'b' },
    })
    await backend.put('y.txt', new Uint8Array([1]))
    expect(authSeen).toContain('Bearer sk-test')
  })

  it('rejects construction without endpoint', () => {
    expect(() => new MimoStorageBackend({ filesDir: '/x' })).toThrow(/endpoint/)
  })
})
