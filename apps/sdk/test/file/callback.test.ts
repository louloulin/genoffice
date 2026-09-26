/**
 * CallbackClient — generic save-callback registration.
 */
import { describe, expect, it } from 'vitest'
import { CallbackClient } from '../../src/file/callback'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'

describe('CallbackClient.register', () => {
  it('POST /api/v1/files/:id/callback with { url }', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ok: true, fileId: 'f.bin', url: 'https://x.test/hook' }, 201),
    )
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.register({ fileId: 'f.bin', url: 'https://x.test/hook' })
    expect(r).toEqual({ ok: true, fileId: 'f.bin', url: 'https://x.test/hook' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/files/f.bin/callback')
    expect(JSON.parse(calls[0].body!)).toEqual({ url: 'https://x.test/hook' })
  })

  it('passes events whitelist when supplied', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ok: true, fileId: 'f', url: 'https://x.test/h' }, 201),
    )
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.register({
      fileId: 'f',
      url: 'https://x.test/h',
      events: ['file.saved', 'file.opened'],
    })
    expect(JSON.parse(calls[0].body!)).toEqual({
      url: 'https://x.test/h',
      events: ['file.saved', 'file.opened'],
    })
  })

  it('rejects non-http(s) URLs at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.register({ fileId: 'f', url: 'javascript:alert(1)' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects malformed events array at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    // @ts-expect-error – test runtime contract
    await expect(
      c.register({ fileId: 'f', url: 'https://x.test/h', events: [1, 2, 3] }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty fileId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.register({ fileId: '', url: 'https://x.test/h' }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toHaveLength(0)
  })

  it('403 → FORBIDDEN', async () => {
    const { fetchImpl } = makeMockFetch(() => errorResponse(403, 'FORBIDDEN', 'no', 'files:callback'))
    const c = new CallbackClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await expect(
      c.register({ fileId: 'f', url: 'https://x.test/h' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
