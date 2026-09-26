/**
 * VersionsClient — generic version-history capability.
 */
import { describe, expect, it } from 'vitest'
import { VersionsClient } from '../../src/file/versions'
import { emptyResponse, errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

const VERSION_META = {
  id: 'v1',
  docId: 'doc-1',
  index: 1,
  timestamp: 1700000000,
  size: 100,
  sha256: 'abc',
}

describe('VersionsClient.list', () => {
  it('GET /api/v1/files/:id/versions returns list', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({
        fileId: 'doc-1',
        count: 2,
        versions: [
          VERSION_META,
          { ...VERSION_META, id: 'v2', index: 2, message: 'manual snapshot' },
        ],
      }),
    )
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.list('doc-1')
    expect(r.count).toBe(2)
    expect(r.versions).toHaveLength(2)
    expect(r.versions[1]).toMatchObject({ message: 'manual snapshot' })
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/versions')
  })

  it('rejects empty fileId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.list('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})

describe('VersionsClient.get', () => {
  it('GET /api/v1/files/:id/versions/:vid returns base64 bytes', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ...VERSION_META, message: 'snapshot', bytes: 'SGVsbG8=' }),
    )
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.get('doc-1', 'v1')
    expect(r.bytes).toBe('SGVsbG8=')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/versions/v1')
  })

  it('encodes path segments with slashes', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ...VERSION_META, bytes: '' }),
    )
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.get('foo/bar', 'v/x')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/foo%2Fbar/versions/v%2Fx')
  })

  it('413 → PAYLOAD_TOO_LARGE', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(413, 'PAYLOAD_TOO_LARGE', 'big', 'files:versions:get'))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.get('doc', 'v')).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })
})

describe('VersionsClient.create', () => {
  it('POST /api/v1/files/:id/versions with body { label }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ...VERSION_META, message: 'my-label' }, 201),
    )
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.create({ fileId: 'doc-1', label: 'my-label' })
    expect(r.message).toBe('my-label')
    expect(JSON.parse(calls[0].body!)).toEqual({ label: 'my-label' })
  })

  it('rejects label > 200 chars at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.create({ fileId: 'doc', label: 'x'.repeat(201) }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('409 → CONFLICT (snapshot dedup)', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(409, 'CONFLICT', 'identical content', 'files:versions:create'))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.create({ fileId: 'doc' })).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('VersionsClient.restore', () => {
  it('POST /api/v1/files/:id/versions/:vid/restore', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ version: 'v3', fileId: 'doc-1' }),
    )
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.restore('doc-1', 'v3')
    expect(r).toEqual({ version: 'v3', fileId: 'doc-1' })
    expect(calls[0].url).toBe('https://x.test/api/v1/files/doc-1/versions/v3/restore')
  })
})

describe('VersionsClient.delete', () => {
  it('DELETE /api/v1/files/:id/versions/:vid returns 204', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => emptyResponse(204))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.delete('doc-1', 'v3')
    expect(r).toEqual({ ok: true, fileId: 'doc-1', versionId: 'v3' })
    expect(calls[0].method).toBe('DELETE')
  })

  it('404 → NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(404, 'NOT_FOUND', 'no', 'files:versions:delete'))
    const c = new VersionsClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.delete('doc', 'v')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
