/**
 * verifyEmbedNonce() — SDK helper that audits a (sessionId, nonce) pair
 * against the server's in-memory nonce store (sdk1.md §11.29).
 *
 * The test pins the SDK-side contract using injected `fetch`; no
 * web-server or jsdom needed.
 */
import { describe, expect, it, vi } from 'vitest'
import { verifyEmbedNonce } from '../src/editor'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('verifyEmbedNonce (sdk1.md §11.29)', () => {
  it('returns valid:true + expiresAt when server confirms the session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { valid: true, expiresAt: 1790000000000 }),
    )
    const result = await verifyEmbedNonce({
      sessionId: 's',
      nonce: 'n',
      host: 'https://genoffice.test',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ valid: true, expiresAt: 1790000000000 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('returns valid:false + reason:unknown when server has no such session', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: false, reason: 'unknown' }))
    const result = await verifyEmbedNonce({
      sessionId: 'never-minted',
      nonce: 'n',
      host: 'https://genoffice.test',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ valid: false, reason: 'unknown' })
  })

  it('returns valid:false + reason:expired when session has TTL-ed', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: false, reason: 'expired' }))
    const result = await verifyEmbedNonce({
      sessionId: 's',
      nonce: 'n',
      host: 'https://genoffice.test',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toEqual({ valid: false, reason: 'expired' })
  })

  it('sends POST to /api/v1/embed/verify-nonce with Bearer + JSON body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: true, expiresAt: 1 }))
    await verifyEmbedNonce({
      sessionId: 's',
      nonce: 'n',
      host: 'https://genoffice.test',
      jwt: 'jwt-xyz',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://genoffice.test/api/v1/embed/verify-nonce',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer jwt-xyz',
          'content-type': 'application/json',
        }),
      }),
    )
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's', nonce: 'n' })
  })

  it('throws AUTH_FAILED on 401 (NOT a valid:false result)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'bad',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', status: 401 })
  })

  it('throws FORBIDDEN on 403', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { error: { code: 'FORBIDDEN' } }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'wrong-scope',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('throws VERIFY_FAILED on 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: { code: 'INTERNAL' } }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED', status: 503 })
  })

  it('throws NETWORK_ERROR when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused')
    })
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('connection refused') as unknown as string })
  })

  it('throws INVALID_RESPONSE on malformed JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response('not-json', { status: 200 }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when valid field is missing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { expiresAt: 1 }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when reason is not unknown|expired', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: false, reason: 'banana' }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when expiresAt is missing on valid:true', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: true }))
    await expect(
      verifyEmbedNonce({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('strips trailing slash from host before building the URL', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: true, expiresAt: 1 }))
    await verifyEmbedNonce({
      sessionId: 's',
      nonce: 'n',
      host: 'https://genoffice.test/',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock.mock.calls[0]![0]).toBe('https://genoffice.test/api/v1/embed/verify-nonce')
  })

  it('throws INVALID_RESPONSE on missing options', async () => {
    await expect(
      // @ts-expect-error testing runtime guard
      verifyEmbedNonce(),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when required field is missing', async () => {
    await expect(
      // @ts-expect-error testing runtime guard — sessionId omitted
      verifyEmbedNonce({ nonce: 'n', host: 'https://x', jwt: 'j' }),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.stringContaining('sessionId') as unknown as string,
    })
  })
})

void vi
