import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { S3StorageBackend } from '../../src/storage/s3'
import { StorageNotFoundError } from '../../src/storage/backend'

interface StoredFile { size: number; contentType?: string; meta?: Record<string, string>; body: Buffer }
let server: Server
let url: string
let store = new Map<string, StoredFile>()
let lastAuth: string | undefined

beforeEach(async () => {
  store = new Map()
  lastAuth = undefined
  server = createServer((req, res) => {
    lastAuth = req.headers.authorization as string | undefined
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
  /* Crude S3 mock: accept any request that has the right SigV4 Authorization
   * header (the AWS SDK signs for real, but for unit tests we only assert that
   * the SDK sent SOMETHING — verifying the exact signature is out of scope
   * for a unit test and is the SDK's job). */
  const urlObj = new URL(req.url ?? '/', 'http://localhost')
  const path = urlObj.pathname
  const bucketMatch = path.match(/^\/([^/]+)\/(.+)$/)
  const bucket = bucketMatch ? bucketMatch[1] : ''
  const key = bucketMatch ? bucketMatch[2] : ''

  if (req.method === 'PUT' && key) {
    const body = await readBody(req)
    store.set(key, {
      size: body.byteLength,
      contentType: (req.headers['content-type'] as string | undefined) ?? undefined,
      meta: parseMetaHeader(req.headers['x-amz-meta-genoffice'] as string | undefined),
      body,
    })
    res.writeHead(200)
    res.end()
    return
  }

  if (req.method === 'GET' && key) {
    const stored = store.get(key)
    if (!stored) { res.writeHead(404); res.end(); return }
    res.writeHead(200, {
      'Content-Length': String(stored.size),
      'Content-Type': stored.contentType ?? 'application/octet-stream',
    })
    res.end(stored.body)
    return
  }

  if (req.method === 'HEAD' && key) {
    const stored = store.get(key)
    if (!stored) { res.writeHead(404); res.end(); return }
    res.writeHead(200, {
      'Content-Length': String(stored.size),
      'Content-Type': stored.contentType ?? 'application/octet-stream',
    })
    res.end()
    return
  }

  if (req.method === 'DELETE' && key) {
    store.delete(key)
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && urlObj.searchParams.get('list-type') === '2') {
    /* ListObjectsV2 — the AWS SDK hits the bucket root with ?list-type=2.
     * With path-style addressing the path is `/<bucket>` and the prefix is a
     * query string. */
    const prefix = urlObj.searchParams.get('prefix') ?? ''
    const items = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.size}</Size><LastModified>2024-01-01T00:00:00.000Z</LastModified><ETag>"deadbeef"</ETag><StorageClass>STANDARD</StorageClass></Contents>`)
      .join('')
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${items ? store.size : 0}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`
    res.writeHead(200, { 'Content-Type': 'application/xml' })
    res.end(xml)
    return
  }

  res.writeHead(404)
  res.end()
}

function parseMetaHeader(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf-8')) } catch { return undefined }
}

function makeBackend(extra: { endpoint?: string; bucket?: string } = {}) {
  return new S3StorageBackend({
    filesDir: '/unused',
    s3: {
      endpoint: extra.endpoint ?? url,
      region: 'us-east-1',
      bucket: extra.bucket ?? 'test-bucket',
      accessKeyId: 'AKIA-test',
      secretAccessKey: 'secret-test',
      forcePathStyle: true,
    },
  })
}

describe('S3StorageBackend', () => {
  it('round-trips bytes via PUT/GET and signs requests with AWS4-HMAC-SHA256', async () => {
    const backend = makeBackend()
    await backend.put('hello.txt', new TextEncoder().encode('s3!'))
    const got = await backend.get('hello.txt')
    expect(new TextDecoder().decode(got)).toBe('s3!')
    expect(lastAuth).toBeDefined()
    expect(lastAuth).toMatch(/AWS4-HMAC-SHA256/)
    expect(lastAuth).toMatch(/Credential=AKIA-test\//)
  })

  it('throws StorageNotFoundError on missing key', async () => {
    const backend = makeBackend()
    await expect(backend.get('nope.bin')).rejects.toBeInstanceOf(StorageNotFoundError)
    const head = await backend.head('nope.bin')
    expect(head.exists).toBe(false)
  })

  it('lists keys with prefix', async () => {
    const backend = makeBackend()
    await backend.put('alpha-1.txt', new Uint8Array([1]))
    await backend.put('alpha-2.txt', new Uint8Array([2]))
    await backend.put('beta-3.txt', new Uint8Array([3]))
    const listed = await backend.list('alpha-')
    expect(listed.map((l) => l.key).sort()).toEqual(['alpha-1.txt', 'alpha-2.txt'])
  })

  it('id is "s3" by default, "rustfs" or "minio" when configured', () => {
    expect(makeBackend({}).id).toBe('s3')
    const rustfs = new S3StorageBackend({
      filesDir: '/unused',
      backend: 'rustfs',
      rustfs: { endpoint: url, accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' },
    })
    expect(rustfs.id).toBe('rustfs')
    const minio = new S3StorageBackend({
      filesDir: '/unused',
      backend: 'minio',
      minio: { endpoint: url, accessKeyId: 'k', secretAccessKey: 's', bucket: 'b' },
    })
    expect(minio.id).toBe('minio')
  })

  it('getSignedUrl issues a presigned URL', async () => {
    const backend = makeBackend()
    await backend.put('x.txt', new Uint8Array([1]))
    const signed = await backend.getSignedUrl('x.txt', { expiresInSeconds: 60 })
    expect(signed).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/test-bucket\/x\.txt\?/)
    expect(signed).toMatch(/X-Amz-Signature=/)
    expect(signed).toMatch(/X-Amz-Expires=60/)
  })

  it('rejects construction without credentials', () => {
    expect(() => new S3StorageBackend({
      filesDir: '/unused',
      s3: { endpoint: url, region: 'us-east-1', bucket: 'b' },
    })).toThrow(/credentials|ACCESS_KEY/)
  })
})
