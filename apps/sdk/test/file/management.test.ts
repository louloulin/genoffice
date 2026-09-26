/**
 * FileClient — generic file-management capability.
 *
 * Covers P0 (list / get / create / delete). Out of scope: versions,
 * comments, callback, embed nonce, raw content download.
 *
 * Test fixture: a `mockFetch` that returns canned responses driven by
 * request URL + method. Asserts method, URL, headers, body shape.
 */
import { describe, expect, it } from 'vitest'
import { FileClient, FileError } from '../../src/file/management'

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
  signal: AbortSignal | undefined
}

interface MockResponseInit {
  status?: number
  headers?: Record<string, string>
  body?: unknown
}

function makeMockFetch(handler: (req: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const req: Captured = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: stringifyHeaders(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal ?? undefined,
    }
    calls.push(req)
    return handler(req)
  }
  return { fetchImpl, calls }
}

function stringifyHeaders(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v))
    return out
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v
    return out
  }
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v
  return out
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code: string, message: string, channel: string): Response {
  return jsonResponse({ error: { code, message, channel } }, status)
}

describe('FileClient — constructor', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new FileClient({ baseUrl: '' })).toThrow(/baseUrl is required/)
  })

  it('strips trailing slash from baseUrl', () => {
    const client = new FileClient({ baseUrl: 'https://x.test/', fetch: makeMockFetch(() => jsonResponse({ files: [] })).fetchImpl })
    expect(client.baseUrl).toBe('https://x.test')
  })
})

describe('FileClient.list', () => {
  it('GET /api/v1/files with bearer, returns metadata array', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({
        files: [
          { id: 'a.bin', name: 'a.bin', size: 10, mtime: 1700000000, path: '/tmp/a.bin' },
          { id: 'b.txt', name: 'b.txt', size: 20, mtime: 1700000001, path: '/tmp/b.txt' },
        ],
      }),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'jwt-1', fetch: fetchImpl })
    const files = await client.list()
    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ id: 'a.bin', size: 10 })
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toBe('https://x.test/api/v1/files')
    expect(calls[0].headers.authorization).toBe('Bearer jwt-1')
    expect(calls[0].headers.accept).toBe('application/json')
  })

  it('omits Authorization when bearer is null', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ files: [] }))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: null, fetch: fetchImpl })
    await client.list()
    expect(calls[0].headers.authorization).toBeUndefined()
  })

  it('maps 401 to FileError with code UNAUTHENTICATED', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(401, 'UNAUTHENTICATED', 'Bearer token required', 'files:list'))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'bad', fetch: fetchImpl })
    await expect(client.list()).rejects.toMatchObject({ code: 'UNAUTHENTICATED', status: 401 })
  })

  it('maps 403 to FileError with code FORBIDDEN', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(403, 'FORBIDDEN', 'nope', 'files:list'))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.list()).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('rejects malformed response shape', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ not: 'files' }))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.list()).rejects.toThrow(/missing `files` array/)
  })

  it('filters out non-conforming entries silently', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      jsonResponse({
        files: [
          { id: 'a', name: 'a', size: 1, mtime: 2, path: '/p' },
          { id: 123, name: 'bad' },
        ],
      }),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const out = await client.list()
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('a')
  })
})

describe('FileClient.get', () => {
  it('GET /api/v1/files/:id, encodes path segment', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ id: 'foo/bar.bin', name: 'bar.bin', size: 4, mtime: 1, path: '/p/bar.bin' }),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const file = await client.get('foo/bar.bin')
    expect(file.id).toBe('foo/bar.bin')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/foo%2Fbar.bin')
  })

  it('404 → NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(404, 'NOT_FOUND', 'no such file', 'files:get'))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.get('missing')).rejects.toBeInstanceOf(FileError)
    await expect(client.get('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects empty id at the call site (no fetch)', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.get('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects id with NUL byte', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.get('a\0b')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('FileClient.create', () => {
  it('POST /api/v1/files with JSON {name, bytes: base64}', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ id: 'new-id', name: 'hello.txt', size: 5, path: '/p/hello.txt' }, 201),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const result = await client.create({ name: 'hello.txt', bytes: new Uint8Array([72, 105]) }) // "Hi"
    expect(result).toEqual({ id: 'new-id', name: 'hello.txt', size: 5, path: '/p/hello.txt' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].headers['content-type']).toBe('application/json')
    const parsed = JSON.parse(calls[0].body!)
    expect(parsed.name).toBe('hello.txt')
    expect(parsed.bytes).toBe('SGk=')
  })

  it('accepts ArrayBuffer input', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ id: 'x', name: 'x', size: 1, path: '/p' }, 201),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await client.create({ name: 'x', bytes: new Uint8Array([1, 2, 3]).buffer })
    const parsed = JSON.parse(calls[0].body!)
    expect(parsed.bytes).toBe('AQID')
  })

  it('accepts Blob input (when Blob is available)', async () => {
    if (typeof Blob === 'undefined') return
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ id: 'x', name: 'x', size: 3, path: '/p' }, 201),
    )
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await client.create({ name: 'x', bytes: new Blob([new Uint8Array([65, 66, 67])]) })
    const parsed = JSON.parse(calls[0].body!)
    expect(parsed.bytes).toBe('QUJD')
  })

  it('rejects missing name without calling fetch', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}, 201))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      client.create({ name: '', bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('413 → PAYLOAD_TOO_LARGE', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(413, 'PAYLOAD_TOO_LARGE', 'too big', 'files:create'))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      client.create({ name: 'big', bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })
})

describe('FileClient.delete', () => {
  it('DELETE /api/v1/files/:id', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ ok: true, deleted: 'a.bin' }))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const out = await client.delete('a.bin')
    expect(out).toEqual({ ok: true, deleted: 'a.bin' })
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/a.bin')
  })

  it('404 → NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(404, 'NOT_FOUND', 'no', 'files:delete'))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.delete('gone')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects empty id at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ ok: true, deleted: '' }))
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(client.delete('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('FileClient — auth + lifecycle', () => {
  it('setBearer swaps token between calls', async () => {
    let bearerSeen: string | null = null
    const { fetchImpl, calls } = makeMockFetch((req) => {
      bearerSeen = req.headers.authorization ?? null
      return jsonResponse({ files: [] })
    })
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'first', fetch: fetchImpl })
    await client.list()
    expect(bearerSeen).toBe('Bearer first')
    client.setBearer('second')
    await client.list()
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer first', 'Bearer second'])
  })

  it('supports async bearer resolver for rotation', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ files: [] }))
    let counter = 0
    const client = new FileClient({
      baseUrl: 'https://x.test',
      bearer: async () => (counter++ === 0 ? 'first' : 'second'),
      fetch: fetchImpl,
    })
    await client.list()
    await client.list()
    expect(calls.map((c) => c.headers.authorization)).toEqual(['Bearer first', 'Bearer second'])
  })

  it('per-call AbortSignal aborts the in-flight request', async () => {
    const { fetchImpl } = makeMockFetch((req) => {
      // Real fetch rejects synchronously when the signal is already aborted;
      // we mirror that to keep the test deterministic across microtask
      // boundaries.
      if (req.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      }
      return new Promise<Response>((resolve, reject) => {
        req.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
        setTimeout(() => resolve(jsonResponse({ files: [] })), 200)
      })
    })
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const ac = new AbortController()
    const promise = client.list({ signal: ac.signal })
    ac.abort()
    await expect(promise).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('timeout fires after the configured ms', async () => {
    const { fetchImpl } = makeMockFetch((req) => {
      if (req.signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'))
      }
      return new Promise<Response>((resolve, reject) => {
        req.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
        setTimeout(() => resolve(jsonResponse({ files: [] })), 200)
      })
    })
    const client = new FileClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl, timeoutMs: 25 })
    await expect(client.list()).rejects.toMatchObject({ code: 'ABORTED' })
  })
})

describe('FileClient.getDownloadUrl', () => {
  it('builds the URL on the configured base', () => {
    const client = new FileClient({ baseUrl: 'https://x.test/office-engine/', fetch: makeMockFetch(() => jsonResponse({ files: [] })).fetchImpl })
    expect(client.getDownloadUrl('a b/c.bin')).toBe('https://x.test/office-engine/api/v1/files/a%20b%2Fc.bin')
  })

  it('rejects empty id', () => {
    const client = new FileClient({ baseUrl: 'https://x.test', fetch: makeMockFetch(() => jsonResponse({})).fetchImpl })
    expect(() => client.getDownloadUrl('')).toThrow(/non-empty path segment/)
  })
})
