/**
 * AuthMintClient — wraps POST /api/v1/auth/jwt.
 */
import { describe, expect, it } from 'vitest'
import { AuthMintClient } from '../../src/auth/mint'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('AuthMintClient.mint', () => {
  it('POST /api/v1/auth/jwt with { sub } and returns token', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 'ey.test', exp: 2000, ttlSeconds: 3600, alg: 'HS256' }),
    )
    const c = new AuthMintClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.mint({ sub: 'user-1' })
    expect(r.token).toBe('ey.test')
    expect(r).toEqual({ token: 'ey.test', exp: 2000, ttlSeconds: 3600, alg: 'HS256' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/auth/jwt')
    expect(JSON.parse(calls[0].body!)).toEqual({ sub: 'user-1' })
  })

  it('forwards scope + doc + ttl when supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 't', exp: 1, ttlSeconds: 60, alg: 'HS256' }),
    )
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await c.mint({ sub: 'admin', scope: ['files:read', 'files:write'], doc: 'doc-1', ttl: 60 })
    expect(JSON.parse(calls[0].body!)).toEqual({
      sub: 'admin',
      scope: ['files:read', 'files:write'],
      doc: 'doc-1',
      ttl: 60,
    })
  })

  it('forwards perm separately from scope', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 't', exp: 1, ttlSeconds: 1, alg: 'HS256' }),
    )
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await c.mint({ sub: 'u', perm: ['admin'] })
    expect(JSON.parse(calls[0].body!)).toEqual({ sub: 'u', perm: ['admin'] })
  })

  it('rejects empty sub at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects whitespace-only sub', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: '   ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects ttl below 30s', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: 'u', ttl: 5 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects ttl above 86400s', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: 'u', ttl: 99_999 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects non-finite ttl', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: 'u', ttl: Number.POSITIVE_INFINITY })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects non-string doc when provided', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.mint({ sub: 'u', doc: 123 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects non-array scope', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.mint({ sub: 'u', scope: 'admin' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects scope with non-string elements', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    // @ts-expect-error – runtime contract test
    await expect(c.mint({ sub: 'u', scope: [1, 2, 3] })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })

  it('503 NOT_CONFIGURED when server has no secret', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(503, 'NOT_CONFIGURED', 'no', 'auth:mint'))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.mint({ sub: 'u' })).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('401 UNAUTHENTICATED when bearer invalid', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(401, 'UNAUTHENTICATED', 'no', 'auth:mint'))
    const c = new AuthMintClient({ baseUrl: 'https://x.test', bearer: 'bad', fetch: fetchImpl })
    await expect(c.mint({ sub: 'u' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('bearerGetter returns the same token every call', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      jsonResponse({ token: 'ey.x', exp: 1, ttlSeconds: 1, alg: 'HS256' }),
    )
    const c = new AuthMintClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const getToken = await c.bearerGetter({ sub: 'u', ttl: 60 })
    expect(getToken()).toBe('ey.x')
    expect(getToken()).toBe('ey.x')
  })
})

describe('AuthMintClient — constructor', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new AuthMintClient({ baseUrl: '' })).toThrow(/baseUrl is required/)
  })
})