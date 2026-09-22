/**
 * Single-use file JWT revocation hook (sdk1.md §B.2 #4 + §11.3 P1) —
 * proves that `verifyJwtWithRevocation` honors the `jti` revocation
 * hook installed by the file JWT endpoint. The endpoint mints tokens
 * with `oneTime: true` and stamps a unique `jti`; the hook should
 * record each `jti` on first verify and reject the second verify.
 *
 * Why a separate test from `files-jwt-options-e2e.test.ts`: that test
 * boots the full bundle and only asserts the minting path; this test
 * imports the auth helpers directly so we can drive `setJtiRevocationCheck`
 * with a deterministic closure (the bundle's installed hook is process-local
 * and resets on restart, so unit-level coverage is the right scope).
 *
 * Tests:
 *   - Token without `jti` passes the revocation hook (default is no-op).
 *   - Token with `jti` passes first verify, fails second verify.
 *   - Different `jti` values are independent.
 *   - `isJtiRevoked(jti)` reflects current state after a verify.
 *   - Tampered tokens still fail (signature check runs before revocation).
 */
import { describe, expect, it, vi } from 'vitest'

// Set the secret BEFORE auth.ts is imported (SECRET is a module-level const).
vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'test-secret-revocation-suite'
})

import {
  signJwt,
  verifyJwt,
  verifyJwtWithRevocation,
  setJtiRevocationCheck,
  isJtiRevoked,
  type JwtPayload,
} from '../src/api/v1/auth'

function basePayload(overrides: Partial<JwtPayload> = {}): JwtPayload {
  const iat = Math.floor(Date.now() / 1000)
  return {
    sub: 'revoke-test',
    iat,
    exp: iat + 600,
    iss: 'genoffice',
    aud: 'genoffice-web',
    ...overrides,
  }
}

describe('auth: file JWT single-use revocation (sdk1.md §11.3 P1)', () => {
  it('passes a token without jti through the default (no-op) revocation hook', () => {
    // Default hook returns false → verifyJwtWithRevocation equals verifyJwt.
    const token = signJwt(basePayload())
    expect(verifyJwt(token)).not.toBeNull()
    expect(verifyJwtWithRevocation(token)).not.toBeNull()
  })

  it('passes a token with jti on first verify, rejects second verify', () => {
    const revoked = new Set<string>()
    setJtiRevocationCheck((jti) => revoked.has(jti) || (revoked.add(jti), false))

    const token = signJwt(basePayload({ jti: 'jti-once-1' }))
    // First verify: hook returns false (records jti), payload is returned.
    expect(verifyJwtWithRevocation(token)?.jti).toBe('jti-once-1')
    // Second verify: hook returns true (jti is now in set), payload is null.
    expect(verifyJwtWithRevocation(token)).toBeNull()
    expect(isJtiRevoked('jti-once-1')).toBe(true)
  })

  it('keeps different jti values independent', () => {
    const revoked = new Set<string>()
    setJtiRevocationCheck((jti) => revoked.has(jti) || (revoked.add(jti), false))

    const tokenA = signJwt(basePayload({ jti: 'jti-A' }))
    const tokenB = signJwt(basePayload({ jti: 'jti-B' }))

    expect(verifyJwtWithRevocation(tokenA)?.jti).toBe('jti-A')
    expect(verifyJwtWithRevocation(tokenB)?.jti).toBe('jti-B')
    expect(verifyJwtWithRevocation(tokenA)).toBeNull()
    expect(verifyJwtWithRevocation(tokenB)).toBeNull()
    expect(isJtiRevoked('jti-A')).toBe(true)
    expect(isJtiRevoked('jti-B')).toBe(true)
  })

  it('exposes isJtiRevoked as the public observability handle', () => {
    const revoked = new Set<string>()
    setJtiRevocationCheck((jti) => revoked.has(jti) || (revoked.add(jti), false))

    expect(isJtiRevoked('never-seen')).toBe(false)
    const token = signJwt(basePayload({ jti: 'jti-observe' }))
    verifyJwtWithRevocation(token)
    expect(isJtiRevoked('jti-observe')).toBe(true)
  })

  it('does not reach the revocation hook for a tampered signature', () => {
    // Track every jti the hook sees; should never be called for the bad token.
    const seen: string[] = []
    setJtiRevocationCheck((jti) => {
      seen.push(jti)
      return false
    })

    const token = signJwt(basePayload({ jti: 'jti-protected' }))
    // Corrupt the FIRST character of the signature, not the last.
    //
    // The last character looks like the obvious choice, but it is not
    // reliable: an HS256 signature is 32 bytes, which base64url-encodes to
    // 43 characters, and the final character carries only the 2 leftover
    // bits. Swapping `A` -> `B` there can therefore decode to the SAME 32
    // bytes, leaving the signature valid and this assertion failing at
    // random (~12% of runs; reproduced at HEAD with no source changes).
    // Character 0 encodes bits 7..2 of byte 0, so changing it always
    // changes the signature.
    const parts = token.split('.')
    const sig = parts[2]
    parts[2] = (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1)
    const tampered = parts.join('.')
    expect(tampered).not.toBe(token)

    expect(verifyJwtWithRevocation(tampered)).toBeNull()
    expect(seen).toEqual([])
  })

  it('handles expiry and revocation together — expired token still returns null', () => {
    const revoked = new Set<string>()
    setJtiRevocationCheck((jti) => revoked.has(jti) || (revoked.add(jti), false))

    const iat = Math.floor(Date.now() / 1000) - 7200 // 2 h ago
    const expired = signJwt({ ...basePayload({ jti: 'jti-old' }), iat, exp: iat + 60 })
    expect(verifyJwtWithRevocation(expired)).toBeNull()
    // Expired tokens short-circuit before the hook runs, so jti is NOT recorded.
    expect(isJtiRevoked('jti-old')).toBe(false)
  })
})
