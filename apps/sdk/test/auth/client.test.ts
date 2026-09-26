/**
 * createAuthedClient — picks WEB_TOKEN vs minted JWT for the dual-auth model.
 */
import { describe, expect, it } from 'vitest'
import { createAuthedClient } from '../../src/auth/client'
import { jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('createAuthedClient — WEB_TOKEN mode', () => {
  it('uses webToken as bearer when supplied and skips mint', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const auth = await createAuthedClient({
      baseUrl: 'https://x.test',
      webToken: 'secret-xyz',
      fetch: fetchImpl,
    })
    expect(auth.mode).toBe('web-token')
    expect(auth.bearer()).toBe('secret-xyz')
    expect(calls).toHaveLength(0)
  })

  it('refresh() in WEB_TOKEN mode returns the same token without minting', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const auth = await createAuthedClient({
      baseUrl: 'https://x.test',
      webToken: 'secret',
      fetch: fetchImpl,
    })
    expect(await auth.refresh()).toBe('secret')
    expect(calls).toHaveLength(0)
  })

  it('treats empty string webToken as not provided', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      jsonResponse({ token: 'ey.jwt', exp: 9999, ttlSeconds: 3600, alg: 'HS256' }),
    )
    const auth = await createAuthedClient({
      baseUrl: 'https://x.test',
      webToken: '',
      mint: { sub: 'u' },
      fetch: fetchImpl,
    })
    expect(auth.mode).toBe('jwt')
  })
})

describe('createAuthedClient — JWT mode', () => {
  it('mints once at boot and caches the token', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 'ey.boot', exp: 9999, ttlSeconds: 3600, alg: 'HS256' }),
    )
    const auth = await createAuthedClient({
      baseUrl: 'https://x.test',
      mint: { sub: 'u', scope: ['files:read'] },
      fetch: fetchImpl,
    })
    expect(auth.mode).toBe('jwt')
    expect(auth.bearer()).toBe('ey.boot')
    expect(auth.bearer()).toBe('ey.boot')
    expect(auth.last?.token).toBe('ey.boot')
    expect(calls).toHaveLength(1)
  })

  it('refresh() re-mints and updates the bearer', async () => {
    let n = 0
    const { fetchImpl } = makeMockFetch(() => {
      n++
      return jsonResponse({
        token: `ey.t${n}`,
        exp: 9999 + n,
        ttlSeconds: 3600,
        alg: 'HS256',
      })
    })
    const auth = await createAuthedClient({
      baseUrl: 'https://x.test',
      mint: { sub: 'u' },
      fetch: fetchImpl,
    })
    expect(auth.bearer()).toBe('ey.t1')
    const fresh = await auth.refresh()
    expect(fresh).toBe('ey.t2')
    expect(auth.bearer()).toBe('ey.t2')
  })

  it('passes ttlSeconds when supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ token: 't', exp: 1, ttlSeconds: 60, alg: 'HS256' }),
    )
    await createAuthedClient({
      baseUrl: 'https://x.test',
      mint: { sub: 'u' },
      ttlSeconds: 60,
      fetch: fetchImpl,
    })
    expect(JSON.parse(calls[0].body!)).toEqual({ sub: 'u', ttl: 60 })
  })

  it('throws when neither webToken nor mint is provided', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({}))
    await expect(
      createAuthedClient({ baseUrl: 'https://x.test', fetch: fetchImpl }),
    ).rejects.toThrow(/webToken.*mint/)
  })
})

describe('createAuthedClient — constructor', () => {
  it('rejects empty baseUrl', async () => {
    await expect(createAuthedClient({ baseUrl: '' })).rejects.toThrow(/baseUrl/)
  })
})