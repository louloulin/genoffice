/**
 * End-to-end lifecycle for the v1 files + comments + versions surface
 * (sdk1.md §B.5.1 #3 + #4 + Kestrel M2/M3).
 *
 * Boots the real bundle via `ServerHarness` and walks the full happy
 * path plus negative-path assertions to lock down:
 *
 *   - POST   /api/v1/files                          create            (files:write)
 *   - GET    /api/v1/files                          list              (files:read)
 *   - GET    /api/v1/files/:id                      metadata          (files:read)
 *   - POST   /api/v1/files/:id/comments             add comment       (files:comment)
 *   - GET    /api/v1/files/:id/comments             list comments     (files:read)
 *   - GET    /api/v1/files/:id/comments/:cid        get one           (files:read)
 *   - PATCH  /api/v1/files/:id/comments/:cid        resolve toggle    (files:comment)
 *   - POST   /api/v1/files/:id/versions             snapshot          (files:write)
 *   - GET    /api/v1/files/:id/versions             list snapshots    (files:read)
 *   - GET    /api/v1/files/:id/versions/:vid        snapshot bytes    (files:read)
 *   - POST   /api/v1/files/:id/versions/:vid/restore restore          (files:restore)
 *   - DELETE /api/v1/files/:id/comments/:cid        remove comment    (files:comment)
 *   - DELETE /api/v1/files/:id/versions/:vid        remove snapshot   (files:restore)
 *   - DELETE /api/v1/files/:id                      remove file       (files:delete)
 *
 * Plus the auth / scope-gate contract:
 *   - 401 UNAUTHENTICATED on missing JWT
 *   - 403 FORBIDDEN on missing scope (no files:comment / no files:restore / no files:delete)
 *   - 400 INVALID_ARGUMENT on bad input (empty text / missing anchor)
 *   - 404 NOT_FOUND on unknown comment id / version id
 *
 * The author is stamped from the JWT sub, NOT from the body. A test
 * sends a bogus `author` in the POST body and asserts the response
 * shows the JWT subject instead.
 *
 * The suite uses the `ServerHarness` from `tests/helpers/v1-smoke.ts`
 * so it can be a model for future "lifecycle" e2e files.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, SmokeRecorder } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface CreateResp {
  id: string
  path: string
  name: string
  size: number
}

interface CommentRow {
  id: string
  author: string
  text: string
  anchor: { line?: number; column?: number }
  resolved: boolean
  createdAt: number
  resolvedAt?: number
}

interface VersionRow {
  id: string
  docId: string
  index: number
  timestamp: number
  size: number
  sha256: string
  message?: string
}

describe.skipIf(skip)('v1 files + comments + versions lifecycle', () => {
  it('walks the full happy path plus auth / scope / bad-input branches', async () => {
    const h = await ServerHarness.start()
    const rec = new SmokeRecorder()
    const adminToken = await h.token('lifecycle-tester', [
      'files:read',
      'files:write',
      'files:comment',
      'files:restore',
      'files:delete',
      'admin',
    ])
    const readerOnlyToken = await h.token('reader-only', ['files:read'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token: adminToken, method: 'POST' as const, headers }
    const authGet = { token: adminToken }
    const authDel = { token: adminToken, method: 'DELETE' as const }
    const authPatch = { token: adminToken, method: 'PATCH' as const, headers }

    let fileId = ''
    let commentId = ''
    let versionId = ''

    try {
      // ── 1. Create file (POST /api/v1/files) ─────────────────────────────────
      {
        const bytes = Buffer.from('lifecycle v1 — initial content\n', 'utf8')
        const r = await h.req<CreateResp>('/api/v1/files', {
          ...authPost,
          body: JSON.stringify({ name: 'lifecycle.md', bytes: bytes.toString('base64') }),
        })
        rec.record('POST /api/v1/files → 201 + id + path + size', r.status === 201 && !!r.body.id && r.body.size === bytes.length, `id=${r.body.id ?? '?'}`)
        fileId = r.body.id ?? ''
      }

      // ── 2. List files (GET /api/v1/files) ────────────────────────────────────
      if (fileId) {
        const r = await h.req<{ files: { id: string }[] }>('/api/v1/files', authGet)
        const found = r.body.files?.some((f) => f.id === fileId) ?? false
        rec.record('GET /api/v1/files shows the new id', r.status === 200 && found, `count=${r.body.files?.length ?? 0}`)
      }

      // ── 3. Get file metadata (GET /api/v1/files/:id) ─────────────────────────
      if (fileId) {
        const r = await h.req<{ id: string; size: number }>(`/api/v1/files/${fileId}`, authGet)
        const initialSize = Buffer.from('lifecycle v1 — initial content\n', 'utf8').length
        rec.record('GET /api/v1/files/:id → 200 + metadata', r.status === 200 && r.body.id === fileId && r.body.size === initialSize, `size=${r.body.size ?? '?'} expected=${initialSize}`)
      }

      // ── 4. Add comment with author spoof attempt ─────────────────────────────
      if (fileId) {
        // Spoofed author must be ignored; the response must show `lifecycle-tester`.
        const r = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileId}/comments`, {
          ...authPost,
          body: JSON.stringify({
            text: 'first comment from lifecycle',
            anchor: { line: 1, column: 2 },
            author: 'spoofed-by-client',
          }),
        })
        const ok = r.status === 201 && r.body.comment?.author === 'lifecycle-tester' && r.body.comment.text === 'first comment from lifecycle'
        rec.record('POST /api/v1/files/:id/comments stamps author from JWT (not body)', ok, `author=${r.body.comment?.author ?? '?'}`)
        commentId = r.body.comment?.id ?? ''
      }

      // ── 5. List comments ─────────────────────────────────────────────────────
      if (fileId) {
        const r = await h.req<{ count: number; comments: CommentRow[] }>(`/api/v1/files/${fileId}/comments`, authGet)
        rec.record('GET /api/v1/files/:id/comments shows the added comment', r.status === 200 && r.body.count === 1 && r.body.comments[0]?.id === commentId, `count=${r.body.count}`)
      }

      // ── 6. Get single comment ────────────────────────────────────────────────
      if (fileId && commentId) {
        const r = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileId}/comments/${commentId}`, authGet)
        rec.record('GET /api/v1/files/:id/comments/:cid returns the comment', r.status === 200 && r.body.comment?.id === commentId, `id=${r.body.comment?.id ?? '?'}`)
      }

      // ── 7. Resolve comment ───────────────────────────────────────────────────
      if (fileId && commentId) {
        const r = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileId}/comments/${commentId}`, {
          ...authPatch,
          body: JSON.stringify({ resolved: true }),
        })
        rec.record('PATCH /api/v1/files/:id/comments/:cid flips resolved=true', r.status === 200 && r.body.comment?.resolved === true && typeof r.body.comment.resolvedAt === 'number', `resolvedAt=${r.body.comment?.resolvedAt ?? '?'}`)
      }

      // ── 8. Create a snapshot ─────────────────────────────────────────────────
      if (fileId) {
        const r = await h.req<VersionRow>(`/api/v1/files/${fileId}/versions`, {
          ...authPost,
          body: JSON.stringify({ label: 'lifecycle-v1' }),
        })
        rec.record('POST /api/v1/files/:id/versions → 201 + index 1', r.status === 201 && r.body.index === 1 && r.body.docId === fileId, `id=${r.body.id ?? '?'}`)
        versionId = r.body.id ?? ''
      }

      // ── 9. List versions ─────────────────────────────────────────────────────
      if (fileId) {
        const r = await h.req<{ count: number; versions: VersionRow[] }>(`/api/v1/files/${fileId}/versions`, authGet)
        rec.record('GET /api/v1/files/:id/versions shows the snapshot', r.status === 200 && r.body.count === 1 && r.body.versions[0]?.id === versionId, `count=${r.body.count}`)
      }

      // ── 10. Restore the snapshot (no-op for matching bytes) ──────────────────
      if (fileId && versionId) {
        const r = await h.req<{ version: string; fileId: string }>(`/api/v1/files/${fileId}/versions/${versionId}/restore`, {
          ...authPost,
          body: JSON.stringify({}),
        })
        rec.record('POST /api/v1/files/:id/versions/:vid/restore → 200 + version id', r.status === 200 && r.body.version === versionId && r.body.fileId === fileId, `version=${r.body.version ?? '?'}`)
      }

      // ── 11. Get the snapshot bytes ──────────────────────────────────────────
      if (fileId && versionId) {
        const r = await h.req<{ bytes: string }>(`/api/v1/files/${fileId}/versions/${versionId}`, authGet)
        const decoded = Buffer.from(r.body.bytes ?? '', 'base64').toString()
        rec.record('GET /api/v1/files/:id/versions/:vid returns base64 bytes', r.status === 200 && decoded === 'lifecycle v1 — initial content\n', `len=${decoded.length}`)
      }

      // ── NEGATIVE: unknown version id ────────────────────────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}/versions/v-does-not-exist`, authGet)
        rec.record('GET unknown version → 404', r.status === 404 && (r.body as { error?: { code?: string } }).error?.code === 'NOT_FOUND', `status=${r.status}`)
      }

      // ── NEGATIVE: unknown comment id ────────────────────────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}/comments/cm_does_not_exist`, authGet)
        rec.record('GET unknown comment → 404', r.status === 404 && (r.body as { error?: { code?: string } }).error?.code === 'NOT_FOUND', `status=${r.status}`)
      }

      // ── NEGATIVE: missing JWT ───────────────────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileId}/comments`)
        rec.record('No JWT → 401', r.status === 401, `status=${r.status}`)
      }

      // ── NEGATIVE: missing files:comment on add comment ──────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}/comments`, {
          token: readerOnlyToken,
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'x', anchor: { line: 1 } }),
        })
        rec.record('files:read-only on POST comment → 403', r.status === 403, `status=${r.status}`)
      }

      // ── NEGATIVE: missing files:restore on restore ──────────────────────────
      if (fileId && versionId) {
        const r = await h.req(`/api/v1/files/${fileId}/versions/${versionId}/restore`, {
          token: readerOnlyToken,
          method: 'POST',
          headers,
          body: JSON.stringify({}),
        })
        rec.record('files:read-only on restore → 403', r.status === 403, `status=${r.status}`)
      }

      // ── NEGATIVE: missing files:delete on file delete ───────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}`, {
          token: readerOnlyToken,
          method: 'DELETE',
        })
        rec.record('files:read-only on file delete → 403', r.status === 403, `status=${r.status}`)
      }

      // ── NEGATIVE: empty text body ──────────────────────────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: '', anchor: { line: 1 } }),
        })
        rec.record('Empty text on POST comment → 400', r.status === 400, `status=${r.status}`)
      }

      // ── NEGATIVE: missing anchor ────────────────────────────────────────────
      if (fileId) {
        const r = await h.req(`/api/v1/files/${fileId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'no anchor' }),
        })
        rec.record('Missing anchor on POST comment → 400', r.status === 400, `status=${r.status}`)
      }

      // ── CLEANUP: delete comment, delete versions, delete file ──────────────
      if (fileId && commentId) {
        const r = await h.req(`/api/v1/files/${fileId}/comments/${commentId}`, authDel)
        rec.record('DELETE /api/v1/files/:id/comments/:cid → 204', r.status === 204, `status=${r.status}`)
      }
      if (fileId) {
        // Delete all versions in the list
        const list = await h.req<{ count: number; versions: VersionRow[] }>(`/api/v1/files/${fileId}/versions`, authGet)
        for (const v of list.body.versions ?? []) {
          const d = await h.req(`/api/v1/files/${fileId}/versions/${v.id}`, authDel)
          rec.record(`DELETE version ${v.index} → 204`, d.status === 204, `status=${d.status}`)
        }
      }
      if (fileId) {
        const r = await h.req<{ ok: boolean; deleted: string }>(`/api/v1/files/${fileId}`, authDel)
        rec.record('DELETE /api/v1/files/:id → 200 + {ok:true}', r.status === 200 && r.body.ok === true && r.body.deleted === fileId, `ok=${r.body.ok ?? '?'}`)
      }
      // After delete, listing should not show the file
      {
        const r = await h.req<{ files: { id: string }[] }>('/api/v1/files', authGet)
        const stillThere = r.body.files?.some((f) => f.id === fileId) ?? false
        rec.record('File removed from list after DELETE', r.status === 200 && !stillThere, `found=${stillThere}`)
      }

      rec.printSummary()
      expect(rec.summary().ok).toBe(true)
    } finally {
      await h.stop()
    }
  }, 60_000)
})
