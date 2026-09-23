/**
 * End-to-end lifecycle for v1 auth sub-validation + scope admin bypass
 * (sdk1.md §11.106).
 *
 * Pins the boundary added by the §11.106 fix:
 *
 *   - POST /api/v1/auth/jwt previously accepted whitespace-only `sub`
 *     (e.g. `"   "`). The check `!body.sub` only rejected the empty
 *     string, so callers could mint JWTs with meaningless sub claims
 *     that surfaced as `"   "` in audit logs / event subscribers.
 *     Now `body.sub.trim().length === 0` is rejected with a clearer
 *     "non-empty" message; the JWT is minted with the trimmed value.
 *
 *   - hasScope previously only honored `sub === 'admin'` as an admin
 *     bypass, NOT `scope === 'admin'`. The v1 docs (e.g.
 *     `apps/web-server/src/api/v1/comments.ts:13`,
 *     `apps/web-server/src/api/v1/ai.ts:38`, etc.) explicitly
 *     advertised `scope: 'admin'` as the admin bypass, so hosts that
 *     followed the documented convention got 403 on admin-only
 *     endpoints like `DELETE /api/v1/files/:id`. Now `claim === 'admin'`
 *     is also honored; `*` and `sub === 'admin'` continue to work as
 *     before (regression coverage below).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 auth sub + scope admin bypass', () => {
  it('walks sub trim + admin scope + regression branches', async () => {
    const h = await ServerHarness.start()
    const headers = { 'content-type': 'application/json' }
    const authPost = (token: string) => ({ token, method: 'POST' as const, headers })

    try {
      // ── 1. sub: '   ' (3 spaces) → 400 INVALID_ARGUMENT ────────────────
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/auth/jwt',
          { method: 'POST', headers, body: JSON.stringify({ sub: '   ' }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('non-empty')
      }

      // ── 2. sub: '\t\t' (2 tabs) → 400 ───────────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>('/api/v1/auth/jwt', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sub: '\t\t' }),
        })
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // ── 3. sub: '' (empty) → still 400 ──────────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>('/api/v1/auth/jwt', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sub: '' }),
        })
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // ── 4. sub: '  alice  ' → 200 + JWT decodes sub = 'alice' ───────────
      {
        const r = await h.req<{ token: string }>('/api/v1/auth/jwt', {
          method: 'POST',
          headers,
          body: JSON.stringify({ sub: '  alice  ' }),
        })
        expect(r.status).toBe(200)
        // JWT format: header.payload.sig, payload is base64url JSON
        const payloadB64 = r.body.token.split('.')[1]!
        const payload = JSON.parse(
          Buffer.from(payloadB64, 'base64url').toString('utf8'),
        ) as { sub: string }
        expect(payload.sub).toBe('alice')
      }

      // ── 5. admin scope bypass for files:delete (the bug class) ──────────
      // Create a file as admin, then DELETE with the admin-scope token —
      // pre-fix this returned 403.
      const adminToken = await h.token('admin-via-scope', ['admin'])
      {
        const create = await h.req<{ id: string }>('/api/v1/files', {
          ...authPost(adminToken),
          body: JSON.stringify({
            name: 'admin-scope-delete.md',
            bytes: Buffer.from('hello\n', 'utf8').toString('base64'),
          }),
        })
        expect(create.status).toBe(201)
        const fid = create.body.id

        const del = await h.req<{ ok: boolean; deleted: string }>(
          `/api/v1/files/${fid}`,
          { method: 'DELETE', token: adminToken },
        )
        expect(del.status).toBe(200)
        expect(del.body.ok).toBe(true)
        expect(del.body.deleted).toBe(fid)
      }

      // ── 6. REGRESSION: scope '*' still bypasses everything ──────────────
      {
        const wildToken = await h.token('wild-via-scope', ['*'])
        const create = await h.req<{ id: string }>('/api/v1/files', {
          ...authPost(wildToken),
          body: JSON.stringify({
            name: 'wild-scope-delete.md',
            bytes: Buffer.from('hi\n', 'utf8').toString('base64'),
          }),
        })
        expect(create.status).toBe(201)
        const del = await h.req(
          `/api/v1/files/${create.body.id}`,
          { method: 'DELETE', token: wildToken },
        )
        expect(del.status).toBe(200)
      }

      // ── 7. REGRESSION: sub === 'admin' still bypasses (internal admin) ─
      {
        const subAdminToken = await h.token('admin', ['files:read'])
        const create = await h.req<{ id: string }>('/api/v1/files', {
          ...authPost(subAdminToken),
          body: JSON.stringify({
            name: 'sub-admin-delete.md',
            bytes: Buffer.from('hi\n', 'utf8').toString('base64'),
          }),
        })
        expect(create.status).toBe(201)
        const del = await h.req(
          `/api/v1/files/${create.body.id}`,
          { method: 'DELETE', token: subAdminToken },
        )
        expect(del.status).toBe(200)
      }

      // ── 8. REGRESSION: scope 'files:write' (no admin) still 403 on DELETE
      {
        const writeOnlyToken = await h.token('write-only', ['files:write'])
        const create = await h.req<{ id: string }>('/api/v1/files', {
          ...authPost(writeOnlyToken),
          body: JSON.stringify({
            name: 'write-only-403.md',
            bytes: Buffer.from('hi\n', 'utf8').toString('base64'),
          }),
        })
        expect(create.status).toBe(201)
        const del = await h.req(
          `/api/v1/files/${create.body.id}`,
          { method: 'DELETE', token: writeOnlyToken },
        )
        expect(del.status).toBe(403)
      }

      // ── 9. REGRESSION: no scope at all (default read-only) → 403 on DELETE
      {
        const noScopeToken = await h.token('no-scope-delete', [])
        const create = await h.req<{ id: string }>('/api/v1/files', {
          ...authPost(await h.token('creator', ['admin'])),
          body: JSON.stringify({
            name: 'no-scope-403.md',
            bytes: Buffer.from('hi\n', 'utf8').toString('base64'),
          }),
        })
        expect(create.status).toBe(201)
        const del = await h.req(
          `/api/v1/files/${create.body.id}`,
          { method: 'DELETE', token: noScopeToken },
        )
        expect(del.status).toBe(403)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
