import { describe, expect, it, vi } from 'vitest'

// IMPORTANT: the secret is captured into a module-level const in auth.ts,
// so the env var must be set before that module is imported. Use vi.hoisted
// to push it ahead of any import.
vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'test-secret-for-scope-tests-only'
})

// Now we can safely import auth.ts — its SECRET constant will pick up the value above.
import { hasScope, signJwt, verifyJwt } from '../src/api/v1/auth'

describe('auth: hasScope (sdk1.md Appendix B.2 #3)', () => {
  it('returns false for a null payload', () => {
    expect(hasScope(null, 'files:read')).toBe(false)
    expect(hasScope(undefined, 'files:read')).toBe(false)
  })

  it('default read-only when no scope claim is present', () => {
    const p = { sub: 'u1', iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'files:read')).toBe(true)
    expect(hasScope(p, 'files:write')).toBe(false)
    expect(hasScope(p, 'ai:chat')).toBe(false)
  })

  it('matches an exact scope', () => {
    const p = { sub: 'u1', scope: ['files:write'], iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'files:write')).toBe(true)
    expect(hasScope(p, 'files:read')).toBe(false)
    expect(hasScope(p, 'files:delete')).toBe(false)
  })

  it('matches wildcard `*` against any scope', () => {
    const p = { sub: 'u1', scope: ['*'], iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'ai:chat')).toBe(true)
    expect(hasScope(p, 'kb:write')).toBe(true)
  })

  it('matches resource-prefix wildcard like `ai:*`', () => {
    const p = { sub: 'u1', scope: ['ai:*'], iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'ai:chat')).toBe(true)
    expect(hasScope(p, 'ai:translate')).toBe(true)
    expect(hasScope(p, 'ai:image')).toBe(true)
    expect(hasScope(p, 'files:write')).toBe(false)
    expect(hasScope(p, 'kb:read')).toBe(false)
  })

  it('treats legacy `perm` as an alias of `scope`', () => {
    const p = { sub: 'u1', perm: ['files:write'], iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'files:write')).toBe(true)
    expect(hasScope(p, 'files:read')).toBe(false)
  })

  it('admin sub always grants every scope', () => {
    const p = { sub: 'admin', iat: 0, exp: 0, iss: 'genoffice', aud: 'genoffice-web' }
    expect(hasScope(p, 'files:read')).toBe(true)
    expect(hasScope(p, 'ai:image')).toBe(true)
  })
})

describe('auth: signJwt / verifyJwt round-trip with scope', () => {
  it('persists scope across sign → verify', () => {
    const token = signJwt({
      sub: 'user-1',
      scope: ['files:read', 'files:write', 'ai:chat'],
      iat: 0,
      exp: Math.floor(Date.now() / 1000) + 60,
      iss: 'genoffice',
      aud: 'genoffice-web',
    })
    const payload = verifyJwt(token)
    expect(payload).not.toBeNull()
    expect(payload?.scope).toEqual(['files:read', 'files:write', 'ai:chat'])
    expect(hasScope(payload, 'files:write')).toBe(true)
    expect(hasScope(payload, 'ai:chat')).toBe(true)
  })

  it('rejects an expired token', () => {
    const token = signJwt({
      sub: 'user-1',
      scope: ['files:read'],
      iat: 0,
      exp: 1,
      iss: 'genoffice',
      aud: 'genoffice-web',
    })
    expect(verifyJwt(token)).toBeNull()
  })
})
