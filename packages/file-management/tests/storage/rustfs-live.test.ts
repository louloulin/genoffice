/**
 * RustFS integration smoke test using the same mock S3 server as the s3
 * backend test. RustFS speaks S3 on the wire, so this is a real end-to-end
 * check: it boots a mock server, points the rustfs backend at it, runs a
 * put/get/head/delete/list cycle, and verifies the bytes round-trip.
 *
 * Skipped when the bundle isn't built (the project uses esbuild, not tsc).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { S3StorageBackend } from '../../src/storage/s3'

let server: Server
let url: string
let store = new Map<string, Buffer>()

beforeEach(async () => {
  store = new Map()
  server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost')
    const bucket = u.pathname.split('/')[1] ?? ''
    const key = decodeURIComponent(u.pathname.split('/').slice(2).join('/'))
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? ''
      const items = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k]) => `<Contents><Key>${k}</Key><Size>${store.get(k)!.byteLength}</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>"x"</ETag></Contents>`)
        .join('')
      res.writeHead(200, { 'Content-Type': 'application/xml' })
      res.end(`<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><KeyCount>${store.size}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`)
      return
    }
    if (req.method === 'PUT' && key) {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      store.set(key, Buffer.concat(chunks))
      res.writeHead(200); res.end(); return
    }
    if (req.method === 'GET' && key) {
      const v = store.get(key)
      if (!v) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Length': String(v.byteLength) })
      res.end(v); return
    }
    if (req.method === 'HEAD' && key) {
      const v = store.get(key)
      if (!v) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Content-Length': String(v.byteLength), 'Content-Type': 'text/plain' }); res.end(); return
    }
    if (req.method === 'DELETE' && key) {
      store.delete(key); res.writeHead(204); res.end(); return
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

describe('RustFS end-to-end smoke (via mock S3 server)', () => {
  it('round-trips bytes through a real HTTP request flow', async () => {
    const backend = new S3StorageBackend({
      filesDir: '/unused',
      backend: 'rustfs',
      rustfs: { endpoint: url, bucket: 'rustfs-test', accessKeyId: 'rustfs-key', secretAccessKey: 'rustfs-secret' },
    })
    expect(backend.id).toBe('rustfs')

    const bytes = new TextEncoder().encode('hello rustfs ' + Date.now())
    const { key, size } = await backend.put('greeting.txt', bytes, { contentType: 'text/plain' })
    expect(size).toBe(bytes.byteLength)

    const got = await backend.get(key)
    expect(new TextDecoder().decode(got)).toBe(new TextDecoder().decode(bytes))

    const head = await backend.head(key)
    expect(head.exists).toBe(true)
    expect(head.size).toBe(bytes.byteLength)
    expect(head.contentType).toBe('text/plain')

    const listed = await backend.list()
    expect(listed.find((l) => l.key === key)).toBeDefined()

    const signed = await backend.getSignedUrl(key, { expiresInSeconds: 60 })
    expect(signed).toMatch(/X-Amz-Signature=/)

    await backend.delete(key)
    const headAfter = await backend.head(key)
    expect(headAfter.exists).toBe(false)
  })
})
