/**
 * EmbedNonceClient — generic embed handshake capability.
 */
import { describe, expect, it } from 'vitest'
import { EmbedNonceClient } from '../../src/embed/nonce'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('EmbedNonceClient — constructor', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new EmbedNonceClient({ baseUrl: '' })).toThrow(/baseUrl is required/)
  })
})

describe('EmbedNonceClient.mint', () => {
  it('POST /api/v1/embed/nonce with { docId } and returns session', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ sessionId: 's1', nonce: 'n1', expiresAt: 1000, ttlMs: 300_000 }),
    )
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.mint({ docId: 'doc-1' })
    expect(r).toEqual({ sessionId: 's1', nonce: 'n1', expiresAt: 1000, ttlMs: 300_000 })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/embed/nonce')
    expect(JSON.parse(calls[0].body!)).toEqual({ docId: 'doc-1' })
  })

  it('passes ttlMs when supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ sessionId: 's', nonce: 'n', expiresAt: 1, ttlMs: 60_000 }),
    )
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.mint({ docId: 'd', ttlMs: 60_000 })
    expect(JSON.parse(calls[0].body!)).toEqual({ docId: 'd', ttlMs: 60_000 })
  })

  it('rejects empty docId at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ docId: '' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects non-positive ttlMs at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.mint({ docId: 'd', ttlMs: 0 })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('401 → UNAUTHENTICATED', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(401, 'UNAUTHENTICATED', 'no', 'embed:nonce'))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'bad', fetch: fetchImpl })
    await expect(c.mint({ docId: 'd' })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })
})

describe('EmbedNonceClient.verify', () => {
  it('POST /api/v1/embed/verify-nonce with { sessionId, nonce }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ valid: true, expiresAt: 999 }),
    )
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.verify({ sessionId: 's', nonce: 'n' })
    expect(r).toEqual({ valid: true, expiresAt: 999 })
    expect(calls[0].url).toBe('https://x.test/api/v1/embed/verify-nonce')
  })

  it('returns { valid: false, reason: "unknown" } without throwing', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ valid: false, reason: 'unknown' }))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.verify({ sessionId: 's', nonce: 'n' })
    expect(r).toEqual({ valid: false, reason: 'unknown' })
  })

  it('returns { valid: false, reason: "expired" }', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ valid: false, reason: 'expired' }))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.verify({ sessionId: 's', nonce: 'n' })
    expect(r).toEqual({ valid: false, reason: 'expired' })
  })

  it('rejects empty sessionId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.verify({ sessionId: '', nonce: 'n' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('EmbedNonceClient.release', () => {
  it('DELETE /api/v1/embed/nonce with { sessionId }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({ released: true }))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.release('s1')
    expect(r).toBe(true)
    expect(calls[0].method).toBe('DELETE')
    expect(calls[0].url).toBe('https://x.test/api/v1/embed/nonce')
    expect(JSON.parse(calls[0].body!)).toEqual({ sessionId: 's1' })
  })

  it('returns false when server already evicted the session', async () => {
    const { fetchImpl } = makeMockFetch(() => jsonResponse({ released: false }))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    expect(await c.release('missing')).toBe(false)
  })

  it('rejects empty sessionId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new EmbedNonceClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(c.release('')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })
})
