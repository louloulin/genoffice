/**
 * Embed handler ↔ server-side nonce session binding (sdk1.md §11.27).
 *
 * The §11.26 commit added the nonce-store + v1 mint/verify endpoints;
 * this test pins the next step — when the host URL carries `?sessionId=`,
 * the embed handler must look it up and reject mismatched / unknown /
 * missing-nonce requests before serving the editor HTML.
 *
 * Without this enforcement the v1 endpoints are useful for an audit but
 * the server itself never gates the iframe load — the host SDK would
 * still need to call /verify-nonce after the fact. With this check, the
 * server actively refuses to render a tampered or replayed URL.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

const APPS_MOCK = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html']

vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'embed-nonce-handler-suite-secret'
})

vi.mock('../src/common/index', () => ({ APPS: APPS_MOCK }))

type Incoming = import('node:http').IncomingMessage

function fakeResponse(): {
  res: ServerResponse
  chunks: Buffer[]
  status: () => number
  body: () => string
  json: () => Record<string, unknown>
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
  }
}

async function loadAuth() {
  return await import('../src/api/v1/auth')
}

async function loadHandler() {
  const mod = await import('../src/embed/index')
  return mod.handleEmbed
}

function basePayload(overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000)
  return {
    sub: 'embed-nonce-handler',
    scope: ['files:read'],
    iat,
    exp: iat + 600,
    iss: 'genoffice',
    aud: 'genoffice-web',
    ...overrides,
  }
}

describe('handleEmbed: server-side nonce session binding (sdk1.md §11.27)', () => {
  beforeAll(() => {
    process.env.GENOFFICE_JWT_SECRET = 'embed-nonce-handler-suite-secret'
  })

  beforeEach(async () => {
    const store = await import('../src/embed/nonce-store')
    store._resetEmbedNonceStore()
  })

  afterEach(async () => {
    const store = await import('../src/embed/nonce-store')
    store._resetEmbedNonceStore()
  })

  it('accepts a valid sessionId + matching nonce (200)', async () => {
    const { signJwt } = await loadAuth()
    const store = await import('../src/embed/nonce-store')
    const handleEmbed = await loadHandler()

    const session = store.mintEmbedNonce('doc_ok', 60_000)!
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_ok?token=${token}&sessionId=${session.sessionId}&nonce=${session.nonce}&app=docs`),
    )
    expect([200, 503]).toContain(resp.status())
    if (resp.status() === 401) {
      throw new Error(`server rejected valid session: ${resp.body()}`)
    }
  })

  it('rejects sessionId + mismatched nonce (401 NONCE_SESSION_INVALID)', async () => {
    const { signJwt } = await loadAuth()
    const store = await import('../src/embed/nonce-store')
    const handleEmbed = await loadHandler()

    const session = store.mintEmbedNonce('doc_mismatch', 60_000)!
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_mismatch?token=${token}&sessionId=${session.sessionId}&nonce=forged&app=docs`),
    )
    expect(resp.status()).toBe(401)
    expect(resp.json()).toMatchObject({ error: { code: 'NONCE_SESSION_INVALID' } })
  })

  it('rejects unknown sessionId (401 NONCE_SESSION_INVALID)', async () => {
    const { signJwt } = await loadAuth()
    const handleEmbed = await loadHandler()
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_unknown?token=${token}&sessionId=never-minted&nonce=never&app=docs`),
    )
    expect(resp.status()).toBe(401)
    expect(resp.json()).toMatchObject({ error: { code: 'NONCE_SESSION_INVALID' } })
  })

  it('rejects expired session (401 NONCE_SESSION_INVALID with reason:expired)', async () => {
    const { signJwt } = await loadAuth()
    const store = await import('../src/embed/nonce-store')
    const handleEmbed = await loadHandler()

    const session = store.mintEmbedNonce('doc_expired', 1)!
    await new Promise((r) => setTimeout(r, 5))
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_expired?token=${token}&sessionId=${session.sessionId}&nonce=${session.nonce}&app=docs`),
    )
    expect(resp.status()).toBe(401)
    expect(resp.json()).toMatchObject({ error: { code: 'NONCE_SESSION_INVALID', message: 'nonce session expired' } })
  })

  it('rejects sessionId present without nonce (400 INVALID_ARGUMENT)', async () => {
    const { signJwt } = await loadAuth()
    const store = await import('../src/embed/nonce-store')
    const handleEmbed = await loadHandler()

    const session = store.mintEmbedNonce('doc_partial', 60_000)!
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_partial?token=${token}&sessionId=${session.sessionId}&app=docs`),
    )
    expect(resp.status()).toBe(400)
    expect(resp.json()).toMatchObject({ error: { code: 'INVALID_ARGUMENT' } })
  })

  it('passes through when neither sessionId nor nonce is present (legacy path, no 401)', async () => {
    const { signJwt } = await loadAuth()
    const handleEmbed = await loadHandler()
    const token = signJwt(basePayload())
    const resp = fakeResponse()
    handleEmbed(
      {} as Incoming,
      resp.res,
      new URL(`http://x/embed/doc_legacy?token=${token}&app=docs`),
    )
    // Legacy §11.20 path: client-side nonce check still works because
    // the iframe bridge echoes the URL ?nonce= (or null) and the host
    // SDK verifies. Server doesn't gate this.
    expect([200, 503]).toContain(resp.status())
    expect(resp.status()).not.toBe(401)
    expect(resp.status()).not.toBe(400)
  })
})

// Re-import `vi` so the afterEach vi.resetModules() doesn't strip this.
// (workaround for vitest's static analysis stripping an unused import)
void vi
