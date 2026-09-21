import { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isAuthorised,
  isPublicApiPath,
  writeUnauthorized,
} from '../src/auth/index'

function fakeRequest(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('auth gate', () => {
  const originalToken = process.env.WEB_TOKEN
  beforeEach(() => {
    delete process.env.WEB_TOKEN
  })

  describe('open posture (no WEB_TOKEN)', () => {
    it('passes any request through', () => {
      expect(isAuthorised(fakeRequest({}))).toBe(true)
      expect(isAuthorised(fakeRequest({ authorization: 'Bearer wrong' }))).toBe(true)
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
  })
})
