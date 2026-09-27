/**
 * openEmbedSession — one-call embed-session bootstrap.
 *
 * Covers the composed order (jwt → nonce → verify → url), the
 * `verify-nonce` 200-with-`valid:false` trap, and the idempotent
 * best-effort cleanup contract.
 */
import { describe, expect, it } from 'vitest'
import { openEmbedSession, isRetryable } from '../../src/file/embed'
import { jsonResponse, makeMockFetch, type CapturedRequest } from '../internal/mock-fetch'

const JWT_OK = { token: 'ey.test', exp: 2000, ttlSeconds: 3600, oneTime: false }
const NONCE_OK = { sessionId: 's-1', nonce: 'n-1', expiresAt: 3000, ttlMs: 300_000 }
const VERIFY_OK = { valid: true, expiresAt: 3000 }

interface MockOpts {
  jwt?: unknown
  jwtStatus?: number
  nonce?: unknown
  verify?: unknown
  release?: unknown
  releaseStatus?: number
}

/** Routes by URL + method — POST and DELETE share `/api/v1/embed/nonce`. */
function makeServer(opts: MockOpts = {}) {
  const {
    jwt = JWT_OK,
    jwtStatus = 200,
    nonce = NONCE_OK,
    verify = VERIFY_OK,
    release = { released: true },
    releaseStatus = 200,
  } = opts
  return makeMockFetch((req: CapturedRequest) => {
    if (req.url.includes('/api/v1/files/') && req.url.endsWith('/jwt')) {
      return jsonResponse(jwt, jwtStatus)
    }
    if (req.url.endsWith('/api/v1/embed/verify-nonce')) return jsonResponse(verify)
    if (req.url.endsWith('/api/v1/embed/nonce')) {
      return req.method === 'DELETE' ? jsonResponse(release, releaseStatus) : jsonResponse(nonce)
    }
    throw new Error(`unexpected request: ${req.method} ${req.url}`)
  })
}

const BASE = 'https://x.test'

describe('openEmbedSession — happy path', () => {
  it('mints jwt + nonce, verifies, and returns an embeddable URL', async () => {
    const { fetchImpl, calls } = makeServer()
    const s = await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', bearer: 'j', fetch: fetchImpl })

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST ${BASE}/api/v1/files/doc-1/jwt`,
      `POST ${BASE}/api/v1/embed/nonce`,
      `POST ${BASE}/api/v1/embed/verify-nonce`,
    ])
    // Every hop is scope-gated (`files:read`) on v1.
    expect(calls.every((c) => c.headers.authorization === 'Bearer j')).toBe(true)

    expect(s.jwt).toBe('ey.test')
    expect(s.jwtExp).toBe(2000)
    expect(s.sessionId).toBe('s-1')
    expect(s.nonce).toBe('n-1')
    expect(s.expiresAt).toBe(3000)

    // Server contract: `/embed/:docId?token=…` (apps/web-server/src/embed/index.ts
    // `parseEmbedQuery`). The doc id is a path segment and the credential is
    // `token` — the retired `/apps/{app}/embedded?doc=&jwt=` shape was never
    // routable, so asserting it here pinned the test to a URL no server serves.
    const url = new URL(s.url)
    expect(url.origin + url.pathname).toBe(`${BASE}/embed/doc-1`)
    expect(url.searchParams.get('app')).toBe('docs')
    expect(url.searchParams.get('token')).toBe('ey.test')
    expect(url.searchParams.get('sessionId')).toBe('s-1')
    expect(url.searchParams.get('nonce')).toBe('n-1')
    // No readonly / locale / theme supplied → no mode / lang / theme params.
    expect(url.searchParams.get('mode')).toBeNull()
    expect(url.searchParams.get('lang')).toBeNull()
    expect(url.searchParams.get('theme')).toBeNull()
  })

  it('sends no body params when optional args are omitted', async () => {
    const { fetchImpl, calls } = makeServer()
    await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl })
    expect(JSON.parse(calls[0].body!)).toEqual({})
    expect(JSON.parse(calls[1].body!)).toEqual({ docId: 'doc-1' })
  })

  it('forwards ttlSeconds / oneTime and nonceTtlMs', async () => {
    const { fetchImpl, calls } = makeServer()
    await openEmbedSession({
      baseUrl: BASE,
      documentId: 'doc-1',
      ttlSeconds: 600,
      oneTime: true,
      nonceTtlMs: 60_000,
      fetch: fetchImpl,
    })
    expect(JSON.parse(calls[0].body!)).toEqual({ ttlSeconds: '600', oneTime: 'true' })
    expect(JSON.parse(calls[1].body!)).toEqual({ docId: 'doc-1', ttlMs: 60_000 })
  })

  it('defaults fileId to documentId and honours an explicit fileId', async () => {
    const a = makeServer()
    await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: a.fetchImpl })
    expect(a.calls[0].url).toBe(`${BASE}/api/v1/files/doc-1/jwt`)

    const b = makeServer()
    await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fileId: 'other.bin', fetch: b.fetchImpl })
    expect(b.calls[0].url).toBe(`${BASE}/api/v1/files/other.bin/jwt`)
  })

  it('honours app / readonly / locale / theme in the URL', async () => {
    const { fetchImpl } = makeServer()
    const s = await openEmbedSession({
      baseUrl: BASE,
      documentId: 'doc-1',
      app: 'sheets',
      readonly: true,
      locale: 'zh',
      theme: 'dark',
      fetch: fetchImpl,
    })
    const url = new URL(s.url)
    expect(url.pathname).toBe('/embed/doc-1')
    expect(url.searchParams.get('app')).toBe('sheets')
    // readonly → mode=view; the dataflare vocabulary's 'system' theme maps to
    // the editor's 'auto' (see buildDataflareEmbedUrl).
    expect(url.searchParams.get('mode')).toBe('view')
    expect(url.searchParams.get('lang')).toBe('zh')
    expect(url.searchParams.get('theme')).toBe('dark')
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { fetchImpl } = makeServer()
    const s = await openEmbedSession({ baseUrl: 'https://x.test/', documentId: 'doc-1', fetch: fetchImpl })
    expect(s.url.startsWith('https://x.test/embed/doc-1')).toBe(true)
  })

  it('allows replacing the URL builder wholesale', async () => {
    const { fetchImpl } = makeServer()
    const s = await openEmbedSession({
      baseUrl: BASE,
      documentId: 'doc-1',
      fetch: fetchImpl,
      buildUrl: (i) => `custom://${i.app}/${i.documentId}?n=${i.nonce}`,
    })
    expect(s.url).toBe('custom://docs/doc-1?n=n-1')
  })
})

describe('openEmbedSession — verify-nonce handling', () => {
  it('skips verification when verifyNonce is false', async () => {
    const { fetchImpl, calls } = makeServer()
    await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', verifyNonce: false, fetch: fetchImpl })
    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/api/v1/files/doc-1/jwt`,
      `${BASE}/api/v1/embed/nonce`,
    ])
  })

  // The trap: a rejected nonce arrives as HTTP 200 with `valid: false`, so
  // any `res.ok`-based check would treat a tampered handshake as success.
  it('throws EMBED_NONCE_INVALID on 200 { valid: false } and releases the session', async () => {
    const { fetchImpl, calls } = makeServer({ verify: { valid: false, reason: 'expired' } })
    await expect(
      openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'EMBED_NONCE_INVALID', channel: 'file:embed:open' })

    // The just-minted session must not be left live in the server LRU.
    const last = calls.at(-1)!
    expect(`${last.method} ${last.url}`).toBe(`DELETE ${BASE}/api/v1/embed/nonce`)
    expect(JSON.parse(last.body!)).toEqual({ sessionId: 's-1' })
  })

  it('surfaces an unknown-reason rejection distinctly', async () => {
    const { fetchImpl } = makeServer({ verify: { valid: false, reason: 'unknown' } })
    await expect(
      openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'EMBED_NONCE_INVALID', message: expect.stringContaining('unknown') })
  })
})

describe('openEmbedSession — argument validation', () => {
  it('rejects a missing baseUrl without making any request', async () => {
    const { fetchImpl, calls } = makeServer()
    await expect(
      openEmbedSession({ baseUrl: '', documentId: 'd', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', channel: 'file:embed:open' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a missing documentId without making any request', async () => {
    const { fetchImpl, calls } = makeServer()
    await expect(
      openEmbedSession({ baseUrl: BASE, documentId: '   ', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', channel: 'file:embed:open' })
    expect(calls).toHaveLength(0)
  })

  it('propagates a mint failure (403 from the scope gate)', async () => {
    const { fetchImpl, calls } = makeServer({
      jwt: { error: { code: 'FORBIDDEN', message: 'missing files:read', channel: 'files:jwt' } },
      jwtStatus: 403,
    })
    await expect(
      openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // A failed JWT mint must not reach the nonce mint.
    expect(calls).toHaveLength(1)
  })
})

describe('openEmbedSession — cleanup()', () => {
  it('is idempotent: repeated calls issue one DELETE and share the result', async () => {
    const { fetchImpl, calls } = makeServer()
    const s = await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl })
    const [a, b] = await Promise.all([s.cleanup(), s.cleanup()])
    expect(a).toEqual({ released: true })
    expect(b).toEqual({ released: true })
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('is best-effort: a failing DELETE reports released:false instead of throwing', async () => {
    const { fetchImpl } = makeServer({ releaseStatus: 500 })
    const s = await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl })
    await expect(s.cleanup()).resolves.toEqual({ released: false })
  })

  it('reports released:false when the server already evicted the session', async () => {
    const { fetchImpl } = makeServer({ release: { released: false } })
    const s = await openEmbedSession({ baseUrl: BASE, documentId: 'doc-1', fetch: fetchImpl })
    await expect(s.cleanup()).resolves.toEqual({ released: false })
  })
})

describe('isRetryable', () => {
  it('retries only transport-level faults', () => {
    expect(isRetryable('NETWORK')).toBe(true)
    expect(isRetryable('INTERNAL')).toBe(true)
  })

  it('never retries a spent nonce', () => {
    expect(isRetryable('EMBED_NONCE_INVALID')).toBe(false)
  })

  it('does not retry request-shape or credential faults', () => {
    for (const code of ['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'ABORTED'] as const) {
      expect(isRetryable(code), code).toBe(false)
    }
  })
})
