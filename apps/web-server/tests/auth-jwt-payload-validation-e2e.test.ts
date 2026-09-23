/**
 * End-to-end contract pin for `/api/v1/auth/jwt` payload validation (sdk1 §11.115).
 *
 * Pins the §11.115 fixes. `POST /api/v1/auth/jwt` previously signed
 * whatever the caller put in `scope` / `perm` / `doc` / `exp` with no
 * type or range validation:
 *
 *   1. `scope`/`perm` that were not arrays of strings threw an opaque
 *      `500 {"error":{"message":"(body.scope ?? []) is not iterable"}}`
 *      (`scope: 123`), OR were silently split into characters
 *      (`scope: "admin"` → `['a','d','m','i','n']`), minting a token
 *      whose scope claim is garbage.
 *   2. A non-string `doc` (`doc: 123`) was signed verbatim — a
 *      spec-violating JWT.
 *   3. `exp: 1e999` produced `exp: null` after JSON serialisation;
 *      `verifyJwt` only checks `typeof exp === 'number'`, so a `null` exp
 *      token was effectively **immortal** — a permanent credential leak
 *      vector. Any `exp` was also unbounded above.
 *   4. The documented request body uses `ttl` (relative seconds, see
 *      docs/api/rest-api.md) but the handler only ever read `exp`
 *      (absolute epoch-seconds), so `{ ttl: 7200 }` silently produced a
 *      1-hour token.
 *
 * A pre-existing `scope: [1,2,3]` token (minted before §11.115 landed, or
 * hand-crafted) also used to crash every scoped endpoint with
 * `500 {"error":{"message":"claim.endsWith is not a function"}}`; the fix
 * filters non-string claims in `hasScope` so such a token simply grants
 * nothing (deny, never an accidental grant).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { ServerHarness, mintJwt } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface JwtResponse {
  token?: string
  exp?: number
  ttlSeconds?: number
  alg?: string
}
interface Envelope {
  error?: { code?: string; message?: string; channel?: string }
}

/** Decode a JWT payload without verifying (we control the secret). */
function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** Hand-craft a token with an arbitrary payload, signed with `secret`. */
function forgeToken(secret: string, payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const full = { iat: now, exp: now + 3600, iss: 'genoffice', aud: 'genoffice-web', ...payload }
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(full)
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

describe.skipIf(skip)('auth/jwt payload validation (sdk1 §11.115)', () => {
  it('rejects mistyped scope/perm/doc and clamps ttl; survives legacy tokens', async () => {
    const h = await ServerHarness.start()
    try {
      const post = (body: unknown) =>
        h.req<JwtResponse & Envelope>('/api/v1/auth/jwt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })

      // ── Phase 1: scope / perm must be arrays of non-empty strings ──
      for (const scope of [123, true, { a: 1 }, 'admin', ['files:read', 5], ['files:read', '']]) {
        const r = await post({ sub: 'u', scope })
        expect(r.status, `scope=${JSON.stringify(scope)} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      for (const perm of ['files:read', 42, ['a', 1]]) {
        const r = await post({ sub: 'u', perm })
        expect(r.status, `perm=${JSON.stringify(perm)} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      // A bare string scope must NOT be silently split into characters.
      const split = await post({ sub: 'u', scope: 'admin' })
      expect(split.status).toBe(400)
      // `null` is the JSON idiom for "not set" → accepted, claim omitted.
      const nullScope = await post({ sub: 'u', scope: null })
      expect(nullScope.status).toBe(200)
      expect('scope' in decodePayload(nullScope.body.token!)).toBe(false)

      // ── Phase 2: doc must be a non-empty string when present ───────
      for (const doc of [123, {}, [], '', '   ']) {
        const r = await post({ sub: 'u', doc })
        expect(r.status, `doc=${JSON.stringify(doc)} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      const nullDoc = await post({ sub: 'u', doc: null })
      expect(nullDoc.status).toBe(200)
      expect('doc' in decodePayload(nullDoc.body.token!)).toBe(false)

      // ── Phase 3: ttl / exp range handling ─────────────────────────
      // A non-finite lifetime must 400. `JSON.stringify(1e999)` is `null`,
      // so send the raw JSON text to actually reach the handler as
      // `Infinity` — this is exactly the payload that previously minted an
      // immortal `exp: null` token.
      const infRaw = await h.req<JwtResponse & Envelope>('/api/v1/auth/jwt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"sub":"u","exp":1e999}',
      })
      expect(infRaw.status).toBe(400)
      expect(infRaw.body.error?.code).toBe('INVALID_ARGUMENT')
      // Same for `ttl`.
      const infTtl = await h.req<JwtResponse & Envelope>('/api/v1/auth/jwt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"sub":"u","ttl":-1e999}',
      })
      expect(infTtl.status).toBe(400)
      expect(infTtl.body.error?.code).toBe('INVALID_ARGUMENT')

      // Documented relative `ttl` is honoured (was silently ignored).
      const ttl7200 = await post({ sub: 'u', ttl: 7200 })
      expect(ttl7200.status).toBe(200)
      expect(ttl7200.body.ttlSeconds).toBe(7200)
      const p7200 = decodePayload(ttl7200.body.token!)
      expect(typeof p7200.exp).toBe('number')
      expect((p7200.exp as number) - Math.floor(Date.now() / 1000)).toBeGreaterThan(7100)

      // Below-floor → clamped up to the 30s minimum (never dead-on-arrival).
      const ttl5 = await post({ sub: 'u', ttl: 5 })
      expect(ttl5.status).toBe(200)
      expect(ttl5.body.ttlSeconds).toBe(30)
      // Above-ceiling → clamped down to the 24h maximum.
      const ttlHuge = await post({ sub: 'u', ttl: 9_999_999 })
      expect(ttlHuge.status).toBe(200)
      expect(ttlHuge.body.ttlSeconds).toBe(86_400)

      // Legacy absolute `exp` still works and is clamped the same way.
      const legacy = await post({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 7200 })
      expect(legacy.status).toBe(200)
      expect(legacy.body.ttlSeconds).toBeGreaterThan(7100)

      // ── Phase 4: a valid mint still works, with real scopes ────────
      const ok = await post({ sub: 'valid-user', scope: ['files:read'], doc: 'doc-1' })
      expect(ok.status).toBe(200)
      expect(ok.body.alg).toBe('HS256')
      const payload = decodePayload(ok.body.token!)
      expect(payload.sub).toBe('valid-user')
      expect(payload.scope).toEqual(['files:read'])
      expect(payload.doc).toBe('doc-1')
      expect(typeof payload.exp).toBe('number')

      // And the minted token is accepted by a scoped endpoint.
      const files = await h.req('/api/v1/files', { token: ok.body.token! })
      expect(files.status).toBe(200)

      // ── Phase 5: legacy numeric-scope token → deny, not 500 ────────
      // A token minted before the fix (or hand-crafted) with a non-string
      // claim used to crash `hasScope` with `claim.endsWith is not a
      // function` on every scoped request. It must now be a clean 403
      // (the garbage claim grants nothing).
      const legacyToken = forgeToken(h.secret, { sub: 'legacy', scope: [1, 2, 3] })
      const legacyRead = await h.req<Envelope>('/api/v1/kb/entries', { token: legacyToken })
      expect(legacyRead.status).toBe(403)
      expect(legacyRead.body.error?.code).toBe('FORBIDDEN')

      // A legacy token whose claim list contains a valid string still
      // authorizes via that string (filtering drops only the bad claims).
      const mixedToken = forgeToken(h.secret, { sub: 'legacy2', scope: [1, 'files:read'] })
      const mixed = await h.req('/api/v1/files', { token: mixedToken })
      expect(mixed.status).toBe(200)

      // Server survived all of it.
      const health = await h.req('/health')
      expect(health.status).toBe(200)
    } finally {
      await h.stop()
    }
  })
})
