/**
 * FileJwtClient — generic file-scoped JWT mint capability.
 */
import { describe, expect, it } from 'vitest'
import { FileJwtClient } from '../../src/file/jwt'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('FileJwtClient.mint', () => {
  it('POST /api/v1/files/:id/jwt with body { ttlSeconds?, oneTime? }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 'ey.test', exp: 2000, ttlSeconds: 3600, oneTime: false }),
    )
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.mint({ fileId: 'f.bin' })
    expect(r.token).toBe('ey.test')
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/f.bin/jwt')
    expect(calls[0].headers.authorization).toBe('Bearer j')
  })

  it('passes ttlSeconds and oneTime as form-encoded body', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 't', exp: 1, ttlSeconds: 30, oneTime: true, jti: 'j' }),
    )
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.mint({ fileId: 'f', ttlSeconds: 30, oneTime: true })
    expect(r).toMatchObject({ oneTime: true, jti: 'j' })
    expect(JSON.parse(calls[0].body!)).toEqual({ ttlSeconds: '30', oneTime: 'true' })
  })

  it('encodes path with special chars', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 't', exp: 1, ttlSeconds: 1, oneTime: false }),
    )
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.mint({ fileId: 'foo/bar.bin' })
    expect(calls[0].url).toBe('https://x.test/api/v1/files/foo%2Fbar.bin/jwt')
  })

  it('rejects ttlSeconds out of range (too low)', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ fileId: 'f', ttlSeconds: 5 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects ttlSeconds out of range (too high)', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ fileId: 'f', ttlSeconds: 99_999 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty fileId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ fileId: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('404 → NOT_FOUND', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(404, 'NOT_FOUND', 'no', 'files:jwt'))
    const c = new FileJwtClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ fileId: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
