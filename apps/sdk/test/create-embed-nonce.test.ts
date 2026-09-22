/**
 * createEmbedNonce() — SDK helper that mints a server-side nonce session
 * via `POST /api/v1/embed/nonce` and returns an embed URL carrying both
 * `?sessionId=` and `?nonce=` (sdk1.md §11.28).
 *
 * The test pins the SDK-side contract without touching the web-server:
 * we inject a fake `fetch` via the `fetchImpl` option and assert the
 * request shape, the response handling, and the produced embed URL.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEmbedNonce } from '../src/editor'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('createEmbedNonce (sdk1.md §11.28)', () => {
  it('mints a session and returns embedUrl carrying sessionId+nonce', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { sessionId: 'abc-123', nonce: 'abc-123', expiresAt: 1790000000000, ttlMs: 300_000 }),
    )
    const result = await createEmbedNonce({
      documentId: 'doc_1',
      app: 'docs',
      jwt: 'jwt-test',
      host: 'https://genoffice.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(result).toMatchObject({
      sessionId: 'abc-123',
      nonce: 'abc-123',
      expiresAt: 1790000000000,
    })
    expect(result.embedUrl).toContain('/embed/doc_1')
    expect(result.embedUrl).toContain('sessionId=abc-123')
    expect(result.embedUrl).toContain('nonce=abc-123')
    expect(result.embedUrl).toContain('token=jwt-test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends POST to /api/v1/embed/nonce with Bearer token + JSON body', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { sessionId: 's', nonce: 's', expiresAt: 1 }),
    )
    await createEmbedNonce({
      documentId: 'doc_2',
      app: 'sheets',
      jwt: 'jwt-xyz',
      host: 'https://genoffice.test',
      ttlMs: 60_000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://genoffice.test/api/v1/embed/nonce',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer jwt-xyz',
          'content-type': 'application/json',
        }),
      }),
    )
    const call = fetchMock.mock.calls[0]!
    const init = call[1] as RequestInit
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toEqual({ docId: 'doc_2', ttlMs: 60_000 })
  })

  it('throws AUTH_FAILED on 401', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: 'UNAUTHENTICATED' } }))
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'bad',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED', status: 401 })
  })

  it('throws FORBIDDEN on 403', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(403, { error: { code: 'FORBIDDEN' } }))
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'wrong-scope',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
  })

  it('throws BAD_REQUEST on 400 with envelope message surfaced', async () => {
    // Server returns 400 because docId is too short. Use a valid-shape
    // documentId so the client-side guard doesn't fire first.
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: { code: 'BAD_REQUEST', message: 'docId too short' } }),
    )
    await expect(
      createEmbedNonce({
        documentId: 'doc_x',
        app: 'docs',
        jwt: 'jwt',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
      message: expect.stringContaining('docId too short') as unknown as string,
    })
  })

  it('throws MINT_FAILED on 5xx with status surfaced', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: { code: 'INTERNAL' } }))
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'jwt',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'MINT_FAILED', status: 503 })
  })

  it('throws NETWORK_ERROR when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'jwt',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('socket hang up') as unknown as string })
  })

  it('throws INVALID_RESPONSE on malformed JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response('not-json', { status: 200 }))
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'jwt',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE when sessionId/nonce/expiresAt missing', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { sessionId: 's' }))
    await expect(
      createEmbedNonce({
        documentId: 'd',
        app: 'docs',
        jwt: 'jwt',
        host: 'https://genoffice.test',
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('strips trailing slash from host before building the URL', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { sessionId: 's', nonce: 's', expiresAt: 1 }),
    )
    const result = await createEmbedNonce({
      documentId: 'd',
      app: 'docs',
      jwt: 'jwt',
      host: 'https://genoffice.test/',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })
    // No double-slash between host and path
    expect(result.embedUrl).toMatch(/^https:\/\/genoffice\.test\/embed\//)
    // fetch target also has no trailing slash
    expect(fetchMock.mock.calls[0]![0]).toBe('https://genoffice.test/api/v1/embed/nonce')
  })

  it('throws INVALID_RESPONSE on missing options', async () => {
    await expect(
      // @ts-expect-error testing runtime guard
      createEmbedNonce(),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('throws INVALID_RESPONSE on missing required field', async () => {
    // Omit `host` so the validation fires before fetch is touched.
    await expect(
      // @ts-expect-error testing runtime guard
      createEmbedNonce({ app: 'docs', jwt: 'j', documentId: 'd' }),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: expect.stringContaining('host') as unknown as string })
  })
})

void vi
