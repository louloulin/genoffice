/**
 * Server-side nonce ↔ session binding for the iframe Embed handshake
 * (sdk1.md §11.26 / §11.20.5 backlog).
 *
 * Covers:
 *   - mint + verify happy path returns `{ valid: true, expiresAt }`
 *   - verify wrong nonce → `{ valid: false, reason: 'unknown' }`
 *   - verify unknown sessionId → `{ valid: false, reason: 'unknown' }`
 *   - verify expired session → `{ valid: false, reason: 'expired' }`
 *   - mint without auth → 401 UNAUTHENTICATED
 *   - mint without `files:read` scope → 403 FORBIDDEN
 *   - mint with invalid body (missing docId / bad ttlMs) → 400 BAD_REQUEST
 *   - LRU cap at 1024 entries evicts oldest
 *   - returned nonce equals sessionId (server uses one value for both)
 *   - v1 dispatcher routes `/api/v1/embed/nonce` and `/api/v1/embed/verify-nonce`
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Inlined literal inside the hoisted factory so it doesn't depend on a
// top-level const (vitest's hoisted callback runs before top-level
// statements; referencing an outer const triggers a TDZ ReferenceError).
vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'embed-nonce-session-suite-secret'
})

type Handler = (ctx: { request: IncomingMessage; response: ServerResponse }) => Promise<boolean> | boolean
type Dispatcher = (ctx: { request: IncomingMessage; response: ServerResponse; pathname: string; method: string }) => Promise<boolean>

function fakeResponse(): {
  res: ServerResponse
  chunks: Buffer[]
  status: () => number
  body: () => string
  json: () => Record<string, unknown>
  headers: () => Record<string, string>
} {
  const chunks: Buffer[] = []
  let status = 0
  const headers: Record<string, string> = {}
  const res: Partial<ServerResponse> = {
    writeHead(s: number, h: Record<string, string> = {}) {
      status = s
      Object.assign(headers, h)
      return res as ServerResponse
    },
    end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return res as ServerResponse
    },
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
  }
  return {
    res: res as ServerResponse,
    chunks,
    status: () => status,
    body: () => Buffer.concat(chunks).toString('utf8'),
    json: () => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
    headers: () => headers,
  }
}

function fakeRequest(method: string, headers: Record<string, string>, body: string): IncomingMessage {
  const req: Partial<IncomingMessage> = {
    method,
    headers,
    url: '/',
    on(event, listener) {
      if (event === 'data') {
        // emit body on next tick so listeners can be attached
        process.nextTick(() => {
          ;(listener as (chunk: Buffer) => void)(Buffer.from(body))
        })
      } else if (event === 'end') {
        process.nextTick(() => {
          ;(listener as () => void)()
        })
      }
      return req as IncomingMessage
    },
    once(event, listener) {
      return this.on(event, listener)
    },
  }
  return req as IncomingMessage
}

async function mintJwt(scope: string[]): Promise<string> {
  const { signJwt } = await import('../src/api/v1/auth')
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: 'embed-nonce-test',
    scope,
    iat: now,
    exp: now + 600,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
}

async function loadHandlers() {
  const mod = await import('../src/api/v1/embed-nonce')
  return {
    handleEmbedNonce: mod.handleEmbedNonce as Handler,
    handleEmbedVerifyNonce: mod.handleEmbedVerifyNonce as Handler,
    handleEmbedReleaseNonce: mod.handleEmbedReleaseNonce as Handler,
  }
}

async function loadDispatcher(): Promise<Dispatcher> {
  const mod = await import('../src/api/v1/index')
  return (ctx) => mod.handleApiV1(ctx)
}

describe('embed nonce session store (sdk1.md §11.26)', () => {
  beforeEach(async () => {
    const store = await import('../src/embed/nonce-store')
    store._resetEmbedNonceStore()
  })

  afterEach(async () => {
    const store = await import('../src/embed/nonce-store')
    store._resetEmbedNonceStore()
  })

  it('mint returns sessionId + nonce + expiresAt, and they are equal', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    const handled = await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_1' })),
      response: fake.res,
    })
    expect(handled).toBe(true)
    expect(fake.status()).toBe(200)
    const body = fake.json()
    expect(typeof body.sessionId).toBe('string')
    expect(typeof body.nonce).toBe('string')
    expect(body.sessionId).toBe(body.nonce)
    expect(typeof body.expiresAt).toBe('number')
    expect(body.expiresAt as number).toBeGreaterThan(Date.now())
    const ttlMs = body.ttlMs as number
    expect(ttlMs).toBeGreaterThan(0)
  })

  it('verify happy path returns valid:true with expiresAt', async () => {
    const { handleEmbedNonce, handleEmbedVerifyNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const mintFake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_2' })),
      response: mintFake.res,
    })
    const { sessionId, nonce, expiresAt } = mintFake.json() as { sessionId: string; nonce: string; expiresAt: number }

    const verifyFake = fakeResponse()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId, nonce })),
      response: verifyFake.res,
    })
    expect(verifyFake.status()).toBe(200)
    expect(verifyFake.json()).toMatchObject({ valid: true, expiresAt })
  })

  it('verify with wrong nonce returns valid:false reason:unknown', async () => {
    const { handleEmbedNonce, handleEmbedVerifyNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const mintFake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_3' })),
      response: mintFake.res,
    })
    const { sessionId } = mintFake.json() as { sessionId: string }

    const verifyFake = fakeResponse()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId, nonce: 'forged' })),
      response: verifyFake.res,
    })
    expect(verifyFake.status()).toBe(200)
    expect(verifyFake.json()).toEqual({ valid: false, reason: 'unknown' })
  })

  it('verify with unknown sessionId returns valid:false reason:unknown', async () => {
    const { handleEmbedVerifyNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const verifyFake = fakeResponse()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: 'never-minted', nonce: 'whatever' })),
      response: verifyFake.res,
    })
    expect(verifyFake.status()).toBe(200)
    expect(verifyFake.json()).toEqual({ valid: false, reason: 'unknown' })
  })

  it('verify with expired session returns valid:false reason:expired', async () => {
    const store = await import('../src/embed/nonce-store')
    const { handleEmbedVerifyNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    // Mint with TTL = 1 ms, then advance fake clock by sleeping slightly.
    const session = store.mintEmbedNonce('doc_exp', 1)
    expect(session).not.toBeNull()
    await sleep(5)
    const verifyFake = fakeResponse()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: session!.sessionId, nonce: session!.nonce })),
      response: verifyFake.res,
    })
    expect(verifyFake.status()).toBe(200)
    expect(verifyFake.json()).toEqual({ valid: false, reason: 'expired' })
  })

  it('mint without auth returns 401 UNAUTHENTICATED', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const fake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', {}, JSON.stringify({ docId: 'doc_no_auth' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(401)
    expect(fake.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', channel: 'embed:nonce' } })
  })

  it('mint without files:read scope returns 403 FORBIDDEN', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const aiOnly = await mintJwt(['ai:chat'])
    const fake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${aiOnly}` }, JSON.stringify({ docId: 'doc_no_scope' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(403)
    expect(fake.json()).toMatchObject({ error: { code: 'FORBIDDEN', channel: 'embed:nonce' } })
  })

  it('mint with empty docId returns 400 BAD_REQUEST', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: '  ' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(400)
    expect(fake.json()).toMatchObject({ error: { code: 'BAD_REQUEST', channel: 'embed:nonce' } })
  })

  it('mint with non-positive ttlMs returns 400 BAD_REQUEST', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_x', ttlMs: 0 })),
      response: fake.res,
    })
    expect(fake.status()).toBe(400)
  })

  it('mint caps ttlMs at the 1-hour MAX_TTL_MS hard limit', async () => {
    const { handleEmbedNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_cap', ttlMs: 24 * 60 * 60 * 1000 })),
      response: fake.res,
    })
    expect(fake.status()).toBe(200)
    const ttlMs = fake.json().ttlMs as number
    expect(ttlMs).toBeLessThanOrEqual(60 * 60 * 1000)
  })

  it('LRU cap evicts oldest entries beyond 1024', async () => {
    const store = await import('../src/embed/nonce-store')
    // 1025 mints with distinct docIds; oldest should be evicted.
    const minted: string[] = []
    for (let i = 0; i < 1025; i++) {
      const entry = store.mintEmbedNonce(`doc_${i}`, 60_000)
      expect(entry).not.toBeNull()
      minted.push(entry!.sessionId)
      // Force ascending mintedAt by spacing calls
      await sleep(0)
    }
    expect(store._embedNonceStoreSize()).toBeLessThanOrEqual(1024)
    const oldest = minted[0]
    const verifyFake = fakeResponse()
    const adminToken = await mintJwt(['files:read'])
    const { handleEmbedVerifyNonce } = await loadHandlers()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: oldest, nonce: oldest })),
      response: verifyFake.res,
    })
    expect(verifyFake.json()).toEqual({ valid: false, reason: 'unknown' })
    // The newest one still validates
    const newest = minted[minted.length - 1]
    const verifyFake2 = fakeResponse()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: newest, nonce: newest })),
      response: verifyFake2.res,
    })
    expect(verifyFake2.json()).toMatchObject({ valid: true })
  })

  it('v1 dispatcher routes /api/v1/embed/nonce to handleEmbedNonce', async () => {
    const dispatcher = await loadDispatcher()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await dispatcher({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'doc_route' })),
      response: fake.res,
      pathname: '/api/v1/embed/nonce',
      method: 'POST',
    })
    expect(fake.status()).toBe(200)
    expect(typeof fake.json().sessionId).toBe('string')
  })

  it('v1 dispatcher routes /api/v1/embed/verify-nonce to handleEmbedVerifyNonce', async () => {
    const dispatcher = await loadDispatcher()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await dispatcher({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: 'never', nonce: 'never' })),
      response: fake.res,
      pathname: '/api/v1/embed/verify-nonce',
      method: 'POST',
    })
    expect(fake.status()).toBe(200)
    expect(fake.json()).toEqual({ valid: false, reason: 'unknown' })
  })

  // ── release (DELETE /api/v1/embed/nonce) — sdk1.md §11.30 ──────────────

  it('release removes a live session and returns released:true', async () => {
    const { handleEmbedNonce, handleEmbedReleaseNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const mintFake = fakeResponse()
    await handleEmbedNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ docId: 'rel_1' })),
      response: mintFake.res,
    })
    const { sessionId } = mintFake.json() as { sessionId: string }

    const releaseFake = fakeResponse()
    await handleEmbedReleaseNonce({
      request: fakeRequest('DELETE', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId })),
      response: releaseFake.res,
    })
    expect(releaseFake.status()).toBe(200)
    expect(releaseFake.json()).toEqual({ released: true })

    // And the session is now gone: verify returns valid:false
    const verifyFake = fakeResponse()
    const { handleEmbedVerifyNonce } = await loadHandlers()
    await handleEmbedVerifyNonce({
      request: fakeRequest('POST', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId, nonce: sessionId })),
      response: verifyFake.res,
    })
    expect(verifyFake.json()).toEqual({ valid: false, reason: 'unknown' })
  })

  it('release on unknown sessionId returns released:false (NOT an error envelope)', async () => {
    const { handleEmbedReleaseNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await handleEmbedReleaseNonce({
      request: fakeRequest('DELETE', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: 'never-minted' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(200)
    expect(fake.json()).toEqual({ released: false })
  })

  it('release without auth returns 401 UNAUTHENTICATED', async () => {
    const { handleEmbedReleaseNonce } = await loadHandlers()
    const fake = fakeResponse()
    await handleEmbedReleaseNonce({
      request: fakeRequest('DELETE', {}, JSON.stringify({ sessionId: 's' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(401)
    expect(fake.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', channel: 'embed:release-nonce' } })
  })

  it('release without files:read scope returns 403 FORBIDDEN', async () => {
    const { handleEmbedReleaseNonce } = await loadHandlers()
    const aiOnly = await mintJwt(['ai:chat'])
    const fake = fakeResponse()
    await handleEmbedReleaseNonce({
      request: fakeRequest('DELETE', { authorization: `Bearer ${aiOnly}` }, JSON.stringify({ sessionId: 's' })),
      response: fake.res,
    })
    expect(fake.status()).toBe(403)
    expect(fake.json()).toMatchObject({ error: { code: 'FORBIDDEN', channel: 'embed:release-nonce' } })
  })

  it('release without sessionId returns 400 BAD_REQUEST', async () => {
    const { handleEmbedReleaseNonce } = await loadHandlers()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await handleEmbedReleaseNonce({
      request: fakeRequest('DELETE', { authorization: `Bearer ${adminToken}` }, JSON.stringify({})),
      response: fake.res,
    })
    expect(fake.status()).toBe(400)
    expect(fake.json()).toMatchObject({ error: { code: 'BAD_REQUEST', channel: 'embed:release-nonce' } })
  })

  it('v1 dispatcher routes DELETE /api/v1/embed/nonce to handleEmbedReleaseNonce', async () => {
    const dispatcher = await loadDispatcher()
    const adminToken = await mintJwt(['files:read'])
    const fake = fakeResponse()
    await dispatcher({
      request: fakeRequest('DELETE', { authorization: `Bearer ${adminToken}` }, JSON.stringify({ sessionId: 'x' })),
      response: fake.res,
      pathname: '/api/v1/embed/nonce',
      method: 'DELETE',
    })
    expect(fake.status()).toBe(200)
    expect(fake.json()).toEqual({ released: false })
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
