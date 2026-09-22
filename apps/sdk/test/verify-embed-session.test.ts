/**
 * verifyEmbedSession() — SDK helper that audits a (sessionId, nonce) pair
 * against the server's in-memory nonce store (sdk1.md §11.32). Symmetric
 * counterpart to `verifyEmbedNonce()` with a more lifecycle-friendly name
 * for the `mint → mount → audit → release` flow.
 *
 * Wire protocol is identical to `verifyEmbedNonce()`; this test pins both
 * the helper's external contract (request shape, error mapping) and the
 * behavioural expectations (valid/expired/unknown/throw).
 */
import { describe, expect, it, vi } from 'vitest'
import { verifyEmbedSession } from '../src/editor'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('verifyEmbedSession (sdk1.md §11.32)', () => {
  it('returns valid:true + expiresAt when server confirms the session', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { valid: true, expiresAt: 1790000000000 }),
    )
    const result = await verifyEmbedSession({
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
    const result = await verifyEmbedSession({
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
    const result = await verifyEmbedSession({
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
    await verifyEmbedSession({
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

  it('throws AUTH_FAILED on 401', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    await expect(
      verifyEmbedSession({
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
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('throws VERIFY_FAILED on 5xx', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(500, { error: { code: 'INTERNAL' } }))
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'VERIFY_FAILED', status: 500 })
  })

  it('throws NETWORK_ERROR when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
  })

  it('throws INVALID_RESPONSE when body is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>nope</html>', { status: 200 }))
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when valid field missing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }))
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when valid:false has unknown reason', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: false, reason: 'magic' }))
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when valid:true lacks expiresAt', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: true }))
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when options missing', async () => {
    await expect(
      verifyEmbedSession(undefined as unknown as Parameters<typeof verifyEmbedSession>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when sessionId missing', async () => {
    await expect(
      verifyEmbedSession({
        nonce: 'n',
        host: 'https://genoffice.test',
        jwt: 'jwt',
      } as unknown as Parameters<typeof verifyEmbedSession>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when nonce missing', async () => {
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        host: 'https://genoffice.test',
        jwt: 'jwt',
      } as unknown as Parameters<typeof verifyEmbedSession>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when host missing', async () => {
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        jwt: 'jwt',
      } as unknown as Parameters<typeof verifyEmbedSession>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when jwt missing', async () => {
    await expect(
      verifyEmbedSession({
        sessionId: 's',
        nonce: 'n',
        host: 'https://genoffice.test',
      } as unknown as Parameters<typeof verifyEmbedSession>[0]),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws NETWORK_ERROR when no fetchImpl and no global fetch', async () => {
    // Save and clear the global fetch so the fallback path is exercised.
    const originalFetch = (globalThis as { fetch?: typeof fetch }).fetch
    delete (globalThis as { fetch?: typeof fetch }).fetch
    try {
      await expect(
        verifyEmbedSession({
          sessionId: 's',
          nonce: 'n',
          host: 'https://genoffice.test',
          jwt: 'jwt',
        }),
      ).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    } finally {
      if (originalFetch) (globalThis as { fetch?: typeof fetch }).fetch = originalFetch
    }
  })

  it('strips trailing slash from host', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { valid: true, expiresAt: 1 }))
    await verifyEmbedSession({
      sessionId: 's',
      nonce: 'n',
      host: 'https://genoffice.test/',
      jwt: 'jwt',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://genoffice.test/api/v1/embed/verify-nonce',
      expect.any(Object),
    )
  })
})
