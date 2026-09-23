/**
 * v1 endpoint POST /api/v1/files/:id/comments — parentId validation
 * (sdk1.md §B.5.1 #4 Kestrel M2 follow-up).
 *
 * Pins the contract introduced by the orphan-reply fix: a `parentId`
 * field, if present, must point to an existing comment on the same
 * file. Without this, an offline-first client retry or a buggy
 * renderer can create dangling pointers that thread UIs can never
 * resolve.
 *
 *   - valid parentId  → 201 (parent and reply round-trip)
 *   - non-existent    → 404 NOT_FOUND
 *   - empty string    → 400 INVALID_ARGUMENT
 *   - non-string      → 400 INVALID_ARGUMENT
 *   - missing         → 201 (top-level, allowed)
 *   - parent in a different file → 404 (file-scoped)
 *
 * Wire-level: boots the real bundle via `ServerHarness`.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

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
  parentId?: string
  anchor: { line?: number; column?: number }
  resolved: boolean
}

describe.skipIf(skip)('v1 comments parentId validation', () => {
  it('rejects orphan, empty, and non-string parentId; accepts valid + missing', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('parent-test', ['files:read', 'files:write', 'files:comment', 'admin'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }
    const authGet = { token }

    try {
      // Create two files so we can test "parent in a different file"
      const bytes = Buffer.from('parent-id validation test\n', 'utf8')
      const fileA = await h.req<CreateResp>('/api/v1/files', {
        ...authPost,
        body: JSON.stringify({ name: 'parent-a.md', bytes: bytes.toString('base64') }),
      })
      const fileB = await h.req<CreateResp>('/api/v1/files', {
        ...authPost,
        body: JSON.stringify({ name: 'parent-b.md', bytes: bytes.toString('base64') }),
      })
      const fileAId = fileA.body.id
      const fileBId = fileB.body.id

      // Create a parent in file A
      const parentResp = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileAId}/comments`, {
        ...authPost,
        body: JSON.stringify({ text: 'real parent in A', anchor: { line: 1 } }),
      })
      expect(parentResp.status).toBe(201)
      const parentId = parentResp.body.comment.id

      // ── valid parentId → 201 ────────────────────────────────────────────
      {
        const r = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'valid reply', anchor: { line: 1 }, parentId }),
        })
        expect(r.status).toBe(201)
        expect(r.body.comment.parentId).toBe(parentId)
      }

      // ── non-existent parentId → 404 ─────────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'orphan reply', anchor: { line: 1 }, parentId: 'cm_does_not_exist' }),
        })
        expect(r.status).toBe(404)
        expect((r.body as { error: { code: string } }).error.code).toBe('NOT_FOUND')
      }

      // ── empty string parentId → 400 ─────────────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'empty parent', anchor: { line: 1 }, parentId: '' }),
        })
        expect(r.status).toBe(400)
        expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
      }

      // ── non-string parentId (number) → 400 ──────────────────────────────
      {
        const r = await h.req(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'number parent', anchor: { line: 1 }, parentId: 123 }),
        })
        expect(r.status).toBe(400)
        expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
      }

      // ── parentId in a DIFFERENT file → 404 (file-scoped) ────────────────
      // fileBId is unrelated to fileAId; replying on fileA pointing to a
      // comment id that exists in fileB must NOT succeed. (The current
      // getComment(fileId, parentId) lookup is file-scoped, so any id
      // outside fileA is "unknown" from fileA's perspective.)
      {
        // Create a comment in file B and grab its id
        const fileBParent = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileBId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'parent in B', anchor: { line: 1 } }),
        })
        expect(fileBParent.status).toBe(201)
        const fileBParentId = fileBParent.body.comment.id

        const r = await h.req(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'cross-file reply', anchor: { line: 1 }, parentId: fileBParentId }),
        })
        expect(r.status).toBe(404)
      }

      // ── missing parentId → 201 (top-level) ──────────────────────────────
      {
        const r = await h.req<{ comment: CommentRow }>(`/api/v1/files/${fileAId}/comments`, {
          ...authPost,
          body: JSON.stringify({ text: 'top-level comment', anchor: { line: 2 } }),
        })
        expect(r.status).toBe(201)
        expect(r.body.comment.parentId).toBeUndefined()
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
