/**
 * End-to-end contract pin for /api/v1/files/:id/jwt malformed-body
 * rejection + /embed/:docId wrong-method 405
 * (sdk1.md §11.109).
 *
 * Pins the boundary added by the §11.109 fix:
 *
 *   - `POST /api/v1/files/:id/jwt` previously had a silent fallback in
 *     `parseBody()`: any malformed JSON or form-encoded body was caught
 *     and replaced with `{}`, so the handler returned 200 with all
 *     defaults. Host SDK bugs (typo in field name, malformed JSON
 *     construction, accidental non-JSON body) silently got a token with
 *     `ttlSeconds:3600, oneTime:false` regardless of what they tried to
 *     send. Now malformed JSON throws `InvalidArgumentError('files:jwt',
 *     'request body is not valid JSON')` and form-encoded bodies with
 *     malformed pairs (`not-json`, etc.) throw `'request body is not
 *     valid form data'`. Both surface as 400 with the v1 envelope.
 *
 *   - `POST /embed/:docId` (and PUT / DELETE) previously fell through
 *     to the SPA fallback and returned `200 + <!doctype html>`. The
 *     caller in `index.ts` only invoked `handleEmbed` for GET, so the
 *     405 path inside `handleEmbed` was unreachable. Now the caller
 *     matches all methods and `handleEmbed` rejects non-GET with 405.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 issue-jwt malformed body + embed 405', () => {
  it('walks malformed-body 400 + embed wrong-method 405 branches', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('jwt-tester', ['files:read', 'files:write', 'admin'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }

    try {
      // ── Setup: create a file to issue JWTs against ─────────────────────
      const create = await h.req<{ id: string }>('/api/v1/files', {
        ...authPost,
        body: JSON.stringify({ name: 'jwt-109.md', bytes: Buffer.from('x').toString('base64') }),
      })
      expect(create.status).toBe(201)
      const fileId = create.body.id

      // ── /api/v1/files/:id/jwt malformed body ────────────────────────────
      // 1. Malformed JSON `not-json` → 400 (not 200 + defaults)
      {
        const r = await h.req<{ error: { code: string; message: string; channel: string } }>(
          `/api/v1/files/${fileId}/jwt`,
          { ...authPost, body: 'not-json' },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.channel).toBe('files:jwt')
        // Message may mention JSON or form data — both are now valid 400 paths.
        expect(r.body.error.message).toMatch(/JSON|form/i)
      }

      // 2. Single `{` (incomplete JSON) → 400 + 'not valid JSON'
      {
        const r = await h.req<{ error: { message: string } }>(
          `/api/v1/files/${fileId}/jwt`,
          { ...authPost, body: '{' },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.message).toMatch(/not valid JSON/)
      }

      // 3. Form-encoded with missing `=` in a pair → 400 + 'not valid form data'
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          `/api/v1/files/${fileId}/jwt`,
          { ...authPost, body: 'ttlSeconds=60&malformed' },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toMatch(/not valid form data/)
      }

      // ── REGRESSION: no body / valid JSON / valid form still 200 ─────────
      // 4. No body → 200 + defaults (backwards compat)
      {
        const r = await h.req<{ token: string; ttlSeconds: number; oneTime: boolean }>(
          `/api/v1/files/${fileId}/jwt`,
          { token, method: 'POST' as const },
        )
        expect(r.status).toBe(200)
        expect(r.body.ttlSeconds).toBe(3600)
        expect(r.body.oneTime).toBe(false)
      }

      // 5. Valid JSON → 200 + ttl applied
      {
        const r = await h.req<{ ttlSeconds: number }>(
          `/api/v1/files/${fileId}/jwt`,
          { ...authPost, body: JSON.stringify({ ttlSeconds: 60 }) },
        )
        expect(r.status).toBe(200)
        expect(r.body.ttlSeconds).toBe(60)
      }

      // 6. Valid form-encoded → 200 + oneTime=true
      {
        const r = await h.req<{ ttlSeconds: number; oneTime: boolean }>(
          `/api/v1/files/${fileId}/jwt`,
          { ...authPost, body: 'ttlSeconds=120&oneTime=true' },
        )
        expect(r.status).toBe(200)
        expect(r.body.ttlSeconds).toBe(120)
        expect(r.body.oneTime).toBe(true)
      }

      // ── /embed/:docId wrong-method 405 ──────────────────────────────────
      // 7. POST → 405 (was 200 + HTML)
      {
        const r = await h.req<{ error: { code: string; allow: string; channel: string } }>(
          `/embed/some-doc?token=${token}`,
          { method: 'POST', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
        expect(r.body.error.allow).toBe('GET')
        expect(r.body.error.channel).toBe('/embed/some-doc')
        expect(r.headers.get('content-type')).toMatch(/^application\/json/)
      }

      // 8. PUT → 405
      {
        const r = await h.req<{ error: { code: string } }>(
          `/embed/some-doc?token=${token}`,
          { method: 'PUT', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // 9. DELETE → 405
      {
        const r = await h.req<{ error: { code: string } }>(
          `/embed/some-doc?token=${token}`,
          { method: 'DELETE', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // ── REGRESSION: GET /embed still serves HTML; bad query params still 400 JSON
      // 10. GET no token → 400 JSON (regression)
      {
        const r = await h.req<{ error: { code: string } }>('/embed/some-doc')
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // 11. GET whitespace docid → 400 JSON (regression)
      {
        const r = await h.req<{ error: { code: string } }>(
          `/embed/${encodeURIComponent('  ')}?token=${token}`,
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
