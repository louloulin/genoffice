/**
 * Files callback endpoint returns 404 for unknown fileId (sdk1 §11.101).
 *
 * Pins the boundary added by §11.101 fix: `POST /api/v1/files/:id/callback`
 * used to silently accept any fileId and call `saveCallback()` with a
 * dangling subscription. Hosts would get `201 ok:true` but the callback
 * would never fire (notifyFileSaved only fires for files that actually
 * got saved). Now 404 mirrors the contract of `/files/:id/jwt`.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 files callback 404 on unknown fileId', () => {
  it('rejects unknown fileId and accepts a real one', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('cb-tester', ['files:read', 'files:write', 'admin'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }

    try {
      // Create a real file so we can register a callback on it
      const bytes = Buffer.from('callback test file\n', 'utf8')
      const create = await h.req<{ id: string }>('/api/v1/files', {
        ...authPost,
        body: JSON.stringify({ name: 'cb-test.md', bytes: bytes.toString('base64') }),
      })
      expect(create.status).toBe(201)
      const realId = create.body.id

      // ── 1. Unknown fileId → 404 NOT_FOUND ─────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/nonexistent-file/callback`, {
          ...authPost,
          body: JSON.stringify({ url: 'http://127.0.0.1:1/test' }),
        })
        expect(r.status).toBe(404)
        expect((r.body as { error: { code: string } }).error.code).toBe('NOT_FOUND')
      }

      // ── 2. Real fileId → 201 ok:true ──────────────────────────────────────
      {
        const r = await h.req<{ ok: boolean; fileId: string; url: string }>(
          `/api/v1/files/${realId}/callback`,
          {
            ...authPost,
            body: JSON.stringify({ url: 'http://127.0.0.1:1/test', events: ['file.saved'] }),
          },
        )
        expect(r.status).toBe(201)
        expect(r.body.ok).toBe(true)
        expect(r.body.fileId).toBe(realId)
      }

      // ── 3. Unknown fileId with valid URL still 404 (not 400) ─────────────
      {
        const r = await h.req(`/api/v1/files/another-bogus/callback`, {
          ...authPost,
          body: JSON.stringify({ url: 'http://127.0.0.1:1/x', events: ['file.saved'] }),
        })
        expect(r.status).toBe(404)
      }

      // ── 4. Real fileId with bad URL → 400 INVALID_ARGUMENT ──────────────
      {
        const r = await h.req(`/api/v1/files/${realId}/callback`, {
          ...authPost,
          body: JSON.stringify({ url: '' }),
        })
        expect(r.status).toBe(400)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
