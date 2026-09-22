/**
 * releaseEmbedNonce() — SDK helper that evicts a server-side nonce
 * session (sdk1.md §11.30). Symmetric counterpart to createEmbedNonce()
 * / verifyEmbedNonce(). Use from iframe destroy() to free the LRU slot.
 */
import { describe, expect, it, vi } from 'vitest'
import { releaseEmbedNonce } from '../src/editor'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('releaseEmbedNonce (sdk1.md §11.30)', () => {
  it('returns released:true when server confirms eviction', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { released: true }))
    const result = await releaseEmbedNonce({
      sessionId: 's',
      host: 'https://genoffice.test',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ released: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns released:false when session already gone (race with TTL)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { released: false }))
    const result = await releaseEmbedNonce({
      sessionId: 'never',
      host: 'https://genoffice.test',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ released: false })
  })

  it('sends DELETE to /api/v1/embed/nonce with Bearer + JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { released: true }))
    await releaseEmbedNonce({
      sessionId: 'sid-abc',
      host: 'https://genoffice.test',
      jwt: 'jwt-xyz',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://genoffice.test/api/v1/embed/nonce',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({
          authorization: 'Bearer jwt-xyz',
          'content-type': 'application/json',
        }),
      }),
    )
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'sid-abc' })
  })

  it('throws AUTH_FAILED on 401', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'bad',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', status: 401 })
  })

  it('throws FORBIDDEN on 403', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { error: { code: 'FORBIDDEN' } }))
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'wrong-scope',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('throws RELEASE_FAILED on 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: { code: 'INTERNAL' } }))
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'RELEASE_FAILED', status: 503 })
  })

  it('throws NETWORK_ERROR when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection reset')
    })
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('connection reset') as unknown as string })
  })

  it('throws INVALID_RESPONSE on malformed JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response('not-json', { status: 200 }))
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when released field missing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }))
    await expect(
      releaseEmbedNonce({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('strips trailing slash from host before building the URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { released: false }))
    await releaseEmbedNonce({
      sessionId: 's',
      host: 'https://genoffice.test/',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://genoffice.test/api/v1/embed/nonce')
  })

  it('throws INVALID_RESPONSE on missing options', async () => {
    await expect(
      // @ts-expect-error testing runtime guard
      releaseEmbedNonce(),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when required field is missing', async () => {
    await expect(
      // @ts-expect-error testing runtime guard — sessionId omitted
      releaseEmbedNonce({ host: 'https://x', jwt: 'j' }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('sessionId') as unknown as string,
    })
  })
})

void vi
