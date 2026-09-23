/**
 * End-to-end contract pin for v1 input validation (sdk1.md §11.112).
 *
 * Walks the documented v1 endpoints and verifies that:
 *
 *   - Required body fields are validated at the REST layer (400
 *     INVALID_ARGUMENT envelope, not 200 + IPC-shape `ok:false` leak).
 *   - Required query parameters reject empty / whitespace-only values.
 *   - Resource-typed query parameters (e.g. KB search `q=`) are trimmed
 *     before delegation so the IPC never has to deal with a malformed
 *     value and never returns 200 + `{ok:false}` for an obviously-empty
 *     input.
 *
 * Pre-§11.112 the most visible bug was `GET /api/v1/kb/search?q=   `
 * returning 200 + `{ok:false, error:'kb_search: \`query\` is required'}`
 * — the REST layer didn't trim, so a whitespace query passed straight
 * through to IPC which rejected it. §11.112 fixes that case
 * (and any other obvious whitespace-only input pattern) by adding a
 * `q.trim()` check before delegation.
 *
 * The test runs each case via the shared `ServerHarness` helper so a
 * regression in the REST layer surfaces immediately on any future
 * refactor of the v1 handlers.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface Envelope {
  error: { code: string; message: string; channel?: string }
}

describe.skipIf(skip)('v1 input validation (sdk1 §11.112)', () => {
  it('rejects empty / whitespace-only inputs at the REST layer (400 INVALID_ARGUMENT)', async () => {
    const h = await ServerHarness.start()
    try {
      // Admin scope bypasses every v1 scope gate (§11.106) so the test
      // exercises input validation independently of permissions.
      const token = await h.token('tester', ['admin'])
      const authJson = { token, headers: { 'content-type': 'application/json' } }
      const authGet = { token }

      // ---- kb search: empty / whitespace q (§11.112 primary fix) ----
      for (const q of ['', '%20', '%20%20%20', '%09%0A']) {
        const res = await h.req<Envelope>(`/api/v1/kb/search?q=${q}`, authGet)
        expect(res.status, `q=${JSON.stringify(q)}`).toBe(400)
        expect(res.body.error.code).toBe('INVALID_ARGUMENT')
        expect(res.body.error.message, `q=${JSON.stringify(q)} message`).toMatch(/non-empty/)
        expect(res.body.error.channel).toBe('kb:search')
      }

      // ---- kb search: ?q= with surrounding whitespace is trimmed, then
      //      used as a real search (returns 200 + entries, not 200 +
      //      ok:false). ----
      // KB search wraps the IPC result under `.details` (the IPC's
      // transport envelope is preserved as-is for host SDKs that want
      // to dig into it). The body shape is
      // `{ ok, details: { ok, entries, count, query }, summary }` —
      // exercise both the wrapper and the inner entries array.
      const trimRes = await h.req<{
        ok?: boolean
        details?: { ok?: boolean; entries?: unknown[] }
      }>(`/api/v1/kb/search?q=${encodeURIComponent('  abc  ')}`, authGet)
      expect(trimRes.status).toBe(200)
      expect(trimRes.body.ok).toBe(true)
      expect(trimRes.body.details?.ok).toBe(true)
      expect(Array.isArray(trimRes.body.details?.entries)).toBe(true)

      // ---- kb search: limit must be a positive integer ----
      const badLimit = await h.req<Envelope>(
        `/api/v1/kb/search?q=test&limit=0`,
        authGet,
      )
      expect(badLimit.status).toBe(400)
      expect(badLimit.body.error.code).toBe('INVALID_ARGUMENT')

      // ---- auth: empty / whitespace sub is rejected (§11.106 + §11.112)
      // Pass LITERAL whitespace into the JSON body (not URL-encoded).
      // These three probes all reject per §11.106 + the trim gate.
      for (const sub of ['', '   ', '\t\t']) {
        const res = await h.req<Envelope>('/api/v1/auth/jwt', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sub }),
        })
        expect(res.status, `sub=${JSON.stringify(sub)}`).toBe(400)
        expect(res.body.error.code, `sub=${JSON.stringify(sub)} code`).toBe('INVALID_ARGUMENT')
        expect(res.body.error.message, `sub=${JSON.stringify(sub)} message`).toMatch(/non-empty/)
      }

      // ---- auth: valid sub produces a real JWT envelope ----
      const okAuth = await h.req<{ token: string; exp: number }>('/api/v1/auth/jwt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub: '  trim-me  ', scope: ['files:read'] }),
      })
      expect(okAuth.status).toBe(200)
      expect(typeof okAuth.body.token).toBe('string')
      // The sub must have been trimmed before signing — `trim-me`,
      // not `  trim-me  ` — so audit logs receive the canonical form.
      const payloadB64 = okAuth.body.token.split('.')[1]
      const pad = '='.repeat((4 - (payloadB64.length % 4)) % 4)
      const payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString())
      expect(payload.sub).toBe('trim-me')

      // ---- embed nonce: empty docId → 400 BAD_REQUEST (§11.112 mirror) ----
      for (const docId of ['', '   ']) {
        const res = await h.req<Envelope>('/api/v1/embed/nonce', {
          ...authJson,
          method: 'POST',
          body: JSON.stringify({ docId }),
        })
        expect(res.status, `docId=${JSON.stringify(docId)}`).toBe(400)
        expect(res.body.error.code).toBe('BAD_REQUEST')
      }

      // ---- embed verify-nonce: missing sessionId/nonce → 400 ----
      const bad = await h.req<Envelope>('/api/v1/embed/verify-nonce', {
        ...authJson,
        method: 'POST',
        body: JSON.stringify({}),
      })
      expect(bad.status).toBe(400)
      expect(bad.body.error.code).toBe('BAD_REQUEST')
      expect(bad.body.error.message).toMatch(/sessionId and nonce required/)

      // ---- oauth: only client_credentials grant supported ----
      const noGrant = await h.req<Envelope>('/api/v1/auth/oauth/token', {
        ...authJson,
        method: 'POST',
        body: 'grant_type=password',
      })
      expect(noGrant.status).toBe(400)
      expect(noGrant.body.error.code).toBe('UNSUPPORTED_GRANT')
    } finally {
      await h.stop()
    }
  }, 30_000)
})
