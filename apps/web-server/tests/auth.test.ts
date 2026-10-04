import { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isAuthorised,
  isPublicApiPath,
  writeUnauthorized,
} from '../src/auth/index'
import { openModeAllowed, resolveAuthority } from '../src/auth/route-policy'

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('auth gate', () => {
  const originalToken = process.env.WEB_TOKEN
  const originalAllowOpen = process.env.GENOFFICE_ALLOW_OPEN
  beforeEach(() => {
    // The vitest config injects GENOFFICE_ALLOW_OPEN=1 so ordinary suites run
    // in the historical open posture; these tests control the posture itself
    // and therefore start from a clean slate every time.
    delete process.env.WEB_TOKEN
    delete process.env.GENOFFICE_ALLOW_OPEN
  })

  describe('gate posture with no WEB_TOKEN configured (resolveAuthority)', () => {
    it('is locked by default — no credential exists to match, so serve nothing', () => {
      expect(resolveAuthority(fakeRequest({}))).toEqual({ kind: 'locked' })
    })
    it('stays locked even when a credential is presented (it cannot match an unset secret)', () => {
      expect(
        resolveAuthority(fakeRequest({ authorization: 'Bearer wrong' })),
      ).toEqual({ kind: 'locked' })
      expect(
        resolveAuthority(fakeRequest({ 'x-genoffice-token': 'wrong' })),
      ).toEqual({ kind: 'locked' })
    })
    it('restores the open posture when GENOFFICE_ALLOW_OPEN=1', () => {
      process.env.GENOFFICE_ALLOW_OPEN = '1'
      expect(resolveAuthority(fakeRequest({}))).toEqual({ kind: 'open' })
      expect(openModeAllowed()).toBe(true)
    })
    it('accepts GENOFFICE_ALLOW_OPEN=true (YAML-style env blocks)', () => {
      process.env.GENOFFICE_ALLOW_OPEN = 'true'
      expect(resolveAuthority(fakeRequest({}))).toEqual({ kind: 'open' })
    })
    it('fails closed on a value that is neither 1 nor true', () => {
      process.env.GENOFFICE_ALLOW_OPEN = 'yes-please'
      expect(resolveAuthority(fakeRequest({}))).toEqual({ kind: 'locked' })
      expect(openModeAllowed()).toBe(false)
    })
    it('still admits a verifying JWT in the locked posture as jwt-open — embed boots run without WEB_TOKEN', async () => {
      // api/v1/auth captures GENOFFICE_JWT_SECRET in a module-level constant,
      // so stub the env and re-import both modules fresh.
      vi.stubEnv('GENOFFICE_JWT_SECRET', 'locked-posture-jwt-secret')
      vi.resetModules()
      try {
        const { signJwt } = await import('../src/api/v1/auth')
        const policy = await import('../src/auth/route-policy')
        const now = Math.floor(Date.now() / 1000)
        const token = signJwt({
          sub: 'embed-guest',
          scope: ['files:read'],
          iat: now,
          exp: now + 600,
          iss: 'genoffice',
          aud: 'genoffice-web',
        })
        const authority = policy.resolveAuthority(
          fakeRequest({ authorization: `Bearer ${token}` }),
        )
        expect(authority?.kind).toBe('jwt-open')
        // jwt-open deliberately skips the route table — the per-channel
        // dispatcher scope gates are the policy on a JWT-only boot.
        expect(policy.jwtScopeFor('GET', '/api/v1/files')).toBe('files:read')
      } finally {
        vi.unstubAllEnvs()
        vi.resetModules()
      }
    })
  })

  describe('isAuthorised (HTML token-injection path — behaviour unchanged)', () => {
    // This helper predates the posture split and only decides whether an HTML
    // response may carry the auth_token cookie. The HTTP gate consults
    // resolveAuthority, not this function, so it keeps admitting everything
    // when WEB_TOKEN is unset; the gate itself is what the posture tests above
    // and the fail-closed e2e cover.
    it('passes any request through when WEB_TOKEN is unset', () => {
      expect(isAuthorised(fakeRequest({}))).toBe(true)
      expect(isAuthorised(fakeRequest({ authorization: 'Bearer wrong' }))).toBe(true)
    })
  })

  describe('gate posture with WEB_TOKEN configured (resolveAuthority)', () => {
    beforeEach(() => {
      process.env.WEB_TOKEN = 's3cret-token'
    })

    it('admits the matching secret as web-token authority', () => {
      expect(resolveAuthority(fakeRequest({ authorization: 'Bearer s3cret-token' }))).toEqual({
        kind: 'web-token',
      })
    })
    it('returns null when no credential is presented — the caller must 401', () => {
      expect(resolveAuthority(fakeRequest({}))).toBeNull()
    })
    it('returns null for a wrong credential', () => {
      expect(resolveAuthority(fakeRequest({ authorization: 'Bearer wrong' }))).toBeNull()
    })
  })

  describe('gated posture (WEB_TOKEN set)', () => {
    beforeEach(() => {
      process.env.WEB_TOKEN = 's3cret-token'
    })

    it('passes on matching Bearer header', () => {
      expect(isAuthorised(fakeRequest({ authorization: 'Bearer s3cret-token' }))).toBe(true)
    })
    it('passes on matching custom header', () => {
      expect(isAuthorised(fakeRequest({ 'x-genoffice-token': 's3cret-token' }))).toBe(true)
    })
    it('rejects mismatched Bearer', () => {
      expect(isAuthorised(fakeRequest({ authorization: 'Bearer wrong' }))).toBe(false)
    })
    it('rejects mismatched custom header', () => {
      expect(isAuthorised(fakeRequest({ 'x-genoffice-token': 'wrong' }))).toBe(false)
    })
    it('rejects empty headers', () => {
      expect(isAuthorised(fakeRequest({}))).toBe(false)
    })
    it('treats Bearer prefix case-insensitively', () => {
      expect(isAuthorised(fakeRequest({ authorization: 'bearer s3cret-token' }))).toBe(true)
      expect(isAuthorised(fakeRequest({ authorization: 'BEARER s3cret-token' }))).toBe(true)
    })
  })


    it('passes on matching auth_token cookie', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      expect(isAuthorised(fakeRequest({ cookie: 'auth_token=s3cret-token' }))).toBe(true)
    })
    it('URL-decodes the cookie value before comparison', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      // %33 decodes to '3', so the cookie 'auth_token=s%33cret-token' carries the raw token
      // 's3cret-token' after RFC 6265 percent-decoding. The auth gate must match.
      expect(isAuthorised(fakeRequest({ cookie: 'auth_token=s%33cret-token' }))).toBe(true)
      // But a cookie that decodes to something different must still be rejected.
      expect(isAuthorised(fakeRequest({ cookie: 'auth_token=s%34cret-token' }))).toBe(false)
      // A cookie mixed in with siblings must still resolve.
      expect(isAuthorised(fakeRequest({ cookie: 'other=foo; auth_token=s3cret-token; x=y' }))).toBe(true)
    })
    it('rejects mismatched cookie', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      expect(isAuthorised(fakeRequest({ cookie: 'auth_token=wrong' }))).toBe(false)
    })
    it('rejects malformed cookie', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      expect(isAuthorised(fakeRequest({ cookie: 'no_equals_sign' }))).toBe(false)
      expect(isAuthorised(fakeRequest({ cookie: '' }))).toBe(false)
    })
    it('falls through to query-param token when cookie absent', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      expect(
        (function () {
          const req = fakeRequest({}) as IncomingMessage & { url: { searchParams: { get: (n: string) => string | null } } }
          req.url = { searchParams: { get: (n: string) => (n === 'token' ? 's3cret-token' : null) } }
          return isAuthorised(req)
        })(),
      ).toBe(true)
    })
    it('cookie is checked alongside headers — header wins when both match', () => {
      process.env.WEB_TOKEN = 's3cret-token'
      expect(isAuthorised(fakeRequest({ authorization: 'Bearer s3cret-token', cookie: 'auth_token=other' }))).toBe(true)
    })

  describe('public path allowlist', () => {
    it('always treats /health and /api/channels as public', () => {
      expect(isPublicApiPath('/health')).toBe(true)
      expect(isPublicApiPath('/api/channels')).toBe(true)
    })
    it('treats /api/html/preview/* as public (read-only pixels)', () => {
      expect(isPublicApiPath('/api/html/preview/abc-123')).toBe(true)
      expect(isPublicApiPath('/api/html/preview/abc/extra')).toBe(true)
    })
    it('treats arbitrary /api/* paths as gated', () => {
      expect(isPublicApiPath('/api/ai/translate')).toBe(false)
      expect(isPublicApiPath('/api/ipc/docs:save')).toBe(false)
    })
  })

  describe('writeUnauthorized response', () => {
    it('writes 401 + WWW-Authenticate + JSON body', () => {
      const headers: Record<string, string | string[]> = {}
      let endPayload = ''
      const res = {
        writeHead(status: number, h: Record<string, string | string[]>) {
          expect(status).toBe(401)
          Object.assign(headers, h)
          return this
        },
        end(payload?: string) {
          endPayload = payload ?? ''
          return this
        },
      } as unknown as ServerResponse
      writeUnauthorized(res, 'token required for /api/ipc/docs:save')
      expect(headers['Content-Type']).toBe('application/json')
      expect(headers['WWW-Authenticate']).toContain('Bearer')
      const body = JSON.parse(endPayload)
      expect(body.error.code).toBe('UNAUTHORIZED')
      expect(body.error.message).toContain('token required')
    })
  })

  // restore
  afterEach(() => {
    if (originalToken === undefined) delete process.env.WEB_TOKEN
    else process.env.WEB_TOKEN = originalToken
    if (originalAllowOpen === undefined) delete process.env.GENOFFICE_ALLOW_OPEN
    else process.env.GENOFFICE_ALLOW_OPEN = originalAllowOpen
  })
})
