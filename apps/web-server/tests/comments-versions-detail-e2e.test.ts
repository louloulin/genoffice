/**
 * End-to-end lifecycle for v1 comments PATCH/GET single-comment and
 * versions GET single-version endpoints (sdk1.md §11.105).
 *
 * Pins the contracts verified via interactive curl probe in the §11.105
 * round. These handlers exist for hosts that don't want to fetch the
 * full list and filter client-side (single-comment GET) or that want
 * to introspect a specific version's bytes (single-version GET). They
 * are not exercised by the broader lifecycle tests, so a wire-level
 * regression here would silently break the "fetch by id" path.
 *
 * Covers:
 *   - GET    /api/v1/files/:id/comments/:cid  (200 + 404)
 *   - PATCH  /api/v1/files/:id/comments/:cid  (resolve toggle, 200 + 400 + 404)
 *   - GET    /api/v1/files/:id/versions/:vid  (200 + 404 + cross-file 404)
 *
 * Plus auth / scope gates.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 comments PATCH/GET + versions GET single', () => {
  it('walks single-comment + single-version + auth / scope / 400 branches', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('cv-tester', [
      'files:read',
      'files:write',
      'files:comment',
      'files:restore',
      'admin',
    ])
    const noRead = await h.token('no-read', ['files:write'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, headers }

    try {
      // ── Setup: create a real file so we have something to attach comments/versions to.
      const bytes = Buffer.from('cv-e2e seed bytes\n', 'utf8')
      const create = await h.req<{ id: string }>('/api/v1/files', {
        ...authPost,
        method: 'POST',
        body: JSON.stringify({ name: 'cv-e2e.md', bytes: bytes.toString('base64') }),
      })
      expect(create.status).toBe(201)
      const fileId = create.body.id

      // Create a comment we can GET / PATCH.
      const commentRes = await h.req<{ comment: { id: string; resolved: boolean } }>(
        `/api/v1/files/${fileId}/comments`,
        {
          ...authPost,
          method: 'POST',
          body: JSON.stringify({
            text: 'initial unresolved comment',
            anchor: { type: 'block', blockId: 'b1' },
          }),
        },
      )
      expect(commentRes.status).toBe(201)
      const commentId = commentRes.body.comment.id
      expect(commentRes.body.comment.resolved).toBe(false)

      // ── 1. GET single comment → 200 ─────────────────────────────────────
      {
        const r = await h.req<{ comment: { id: string; resolved: boolean; text: string } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          { token },
        )
        expect(r.status).toBe(200)
        expect(r.body.comment.id).toBe(commentId)
        expect(r.body.comment.resolved).toBe(false)
        expect(r.body.comment.text).toBe('initial unresolved comment')
      }

      // ── 2. GET unknown comment → 404 ───────────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/${fileId}/comments/no-such-cid`,
          { token },
        )
        expect(r.status).toBe(404)
        expect(r.body.error.code).toBe('NOT_FOUND')
      }

      // ── 3. PATCH resolved:true → 200 + comment.resolved=true ───────────
      {
        const r = await h.req<{ comment: { id: string; resolved: boolean } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          {
            ...authPost,
            method: 'PATCH',
            body: JSON.stringify({ resolved: true }),
          },
        )
        expect(r.status).toBe(200)
        expect(r.body.comment.id).toBe(commentId)
        expect(r.body.comment.resolved).toBe(true)
      }

      // ── 4. PATCH resolved:false (toggle back) → 200 ────────────────────
      {
        const r = await h.req<{ comment: { resolved: boolean } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          { ...authPost, method: 'PATCH', body: JSON.stringify({ resolved: false }) },
        )
        expect(r.status).toBe(200)
        expect(r.body.comment.resolved).toBe(false)
      }

      // ── NEGATIVE: PATCH missing `resolved` → 400 ───────────────────────
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          { ...authPost, method: 'PATCH', body: JSON.stringify({}) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('resolved')
      }

      // ── NEGATIVE: PATCH bad type → 400 ─────────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          { ...authPost, method: 'PATCH', body: JSON.stringify({ resolved: 'yes' }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // ── NEGATIVE: PATCH invalid JSON → 400 ─────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          { ...authPost, method: 'PATCH', body: 'not-json' },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // ── NEGATIVE: PATCH unknown id → 404 ───────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/${fileId}/comments/no-such-cid`,
          { ...authPost, method: 'PATCH', body: JSON.stringify({ resolved: true }) },
        )
        expect(r.status).toBe(404)
        expect(r.body.error.code).toBe('NOT_FOUND')
      }

      // ── NEGATIVE: PATCH wrong file id (cid doesn't exist under that file) → 404
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/no-such-file/comments/${commentId}`,
          { ...authPost, method: 'PATCH', body: JSON.stringify({ resolved: true }) },
        )
        expect(r.status).toBe(404)
        expect(r.body.error.code).toBe('NOT_FOUND')
      }

      // ── NEGATIVE: PATCH without files:comment → 403 ────────────────────
      {
        const r = await h.req(
          `/api/v1/files/${fileId}/comments/${commentId}`,
          {
            method: 'PATCH',
            headers,
            token: noRead,
            body: JSON.stringify({ resolved: true }),
          },
        )
        expect(r.status).toBe(403)
      }

      // ── NEGATIVE: GET without JWT → 401 ────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileId}/comments/${commentId}`)
        expect(r.status).toBe(401)
      }

      // ── VERSIONS: create a snapshot then GET it ────────────────────────
      const verCreate = await h.req<{ id: string; sha256: string; size: number }>(
        `/api/v1/files/${fileId}/versions`,
        {
          ...authPost,
          method: 'POST',
          body: JSON.stringify({ label: 'cv-e2e-version-1' }),
        },
      )
      expect(verCreate.status).toBe(201)
      const versionId = verCreate.body.id
      expect(verCreate.body.size).toBe(bytes.length)

      // ── 13. GET single version → 200 + bytes round-trip ─────────────────
      {
        const r = await h.req<{
          id: string
          bytes: string
          sha256: string
          size: number
        }>(`/api/v1/files/${fileId}/versions/${versionId}`, { token })
        expect(r.status).toBe(200)
        expect(r.body.id).toBe(versionId)
        expect(r.body.size).toBe(bytes.length)
        expect(r.body.sha256).toBe(verCreate.body.sha256)
        expect(Buffer.from(r.body.bytes, 'base64').toString('utf8')).toBe(bytes.toString('utf8'))
      }

      // ── 14. GET unknown version → 404 ──────────────────────────────────
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/${fileId}/versions/no-such-vid`,
          { token },
        )
        expect(r.status).toBe(404)
        expect(r.body.error.code).toBe('NOT_FOUND')
      }

      // ── 15. GET cross-file version → 404 (vid doesn't exist under that file)
      {
        const r = await h.req<{ error: { code: string } }>(
          `/api/v1/files/no-such-file/versions/${versionId}`,
          { token },
        )
        expect(r.status).toBe(404)
        expect(r.body.error.code).toBe('NOT_FOUND')
      }

      // ── NEGATIVE: GET without JWT → 401 ────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileId}/versions/${versionId}`)
        expect(r.status).toBe(401)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
