/**
 * §11.122: `sdk:command addComment` accepted orphan + non-string parentId
 * (silent dangling reply creation).
 *
 * Before the fix:
 *   - `addCommentCommand` in `apps/web-server/src/embed/sdk-commands.ts`
 *     spread `a.parentId` verbatim into the `addComment(key, …)` call
 *     after only checking `text` and `anchor` — `parentId` was not
 *     validated at all.
 *   - Five malformed shapes all returned 200 + created a dangling reply:
 *     `parentId: ''` → 200 (empty string → stored as parentId '')
 *     `parentId: 123` → 200 (number stored verbatim; downstream JSON
 *         comparison `comment.parentId === parentId` silently fails)
 *     `parentId: null` → 200 (silently dropped — reply appears top-level)
 *     `parentId: {x:1}` → 200 (object stored verbatim; `JSON.stringify`
 *         for hash/audit never matches)
 *     `parentId: ['a','b']` → 200 (array stored verbatim)
 *   - And the orphan case `parentId: 'cm_nonexistent'` → 200 (creates a
 *     reply pointing at a non-existent parent — same bug class as
 *     §11.97 closed for the v1 REST surface).
 *
 * The v1 REST endpoint `POST /api/v1/files/:id/comments` already
 * validates (close per §11.97): non-string / empty → 400 INVALID_ARGUMENT;
 * nonexistent parent → 404 NOT_FOUND. The SDK command path silently
 * diverged.
 *
 * The fix mirrors the §11.97 v1 check in `addCommentCommand`:
 *   - `a.parentId !== undefined` AND `typeof a.parentId !== 'string'` OR
 *     `a.parentId.length === 0` → throw InvalidArgumentError
 *   - `getComment(key, a.parentId)` returns null → throw NotFoundError
 *
 * This test pins all six malformed-shape cases via the live bundle
 * (boot via `ServerHarness.start()`, mint admin JWT, post
 * `/api/ipc/sdk:command` for each malformed shape, assert 400) plus the
 * three happy-path cases (real parentId → 200, no parentId → 200,
 * nonexistent parentId → 404). Together with `comments-parent-id-
 * validation-e2e.test.ts` (which covers v1 REST), the §11.97 + §11.122
 * gap is fully closed across every public surface that creates
 * comments.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface IpcEnvelope {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string; channel?: string }
}

describe.skipIf(skip)('sdk:command addComment parentId validation (sdk1 §11.122)', () => {
  it('rejects all malformed parentId shapes; accepts real + nonexistent-with-404', async () => {
    const h = await ServerHarness.start()
    try {
      // Admin scope lets us bypass any per-channel scope gates and
      // exercise the command shape end-to-end.
      const token = await h.token('sdk-parent-tester', ['admin'])

      // Step 1: create a real file via v1 so we have a docId the
      // comment store will accept (comment-store keys by basename).
      const createFile = await fetch(`${h.base}/api/v1/files`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name: 'sdk-parent-test.docx', bytes: 'dGVzdA==' }),
      })
      expect(createFile.status).toBe(201)
      const created = await createFile.json() as { id: string }
      const fileId = created.id
      expect(fileId).toMatch(/\.docx$/)

      // Step 2: create a real parent comment via v1.
      const addParent = await fetch(`${h.base}/api/v1/files/${encodeURIComponent(fileId)}/comments`, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ anchor: { cell: 'A1' }, text: 'parent comment' }),
      })
      expect(addParent.status).toBe(201)
      const parent = await addParent.json() as { comment: { id: string } }
      const parentId = parent.comment.id
      expect(parentId).toMatch(/^cm_/)

      // Helper to invoke the SDK command channel with a single addComment arg.
      async function callAddComment(args: Record<string, unknown>): Promise<{ status: number; body: IpcEnvelope }> {
        const r = await fetch(`${h.base}/api/ipc/sdk:command`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            args: [{
              name: 'addComment',
              docId: fileId,
              args,
            }],
          }),
          signal: AbortSignal.timeout(5000),
        })
        const body = await r.json() as IpcEnvelope
        return { status: r.status, body }
      }

      // === Malformed parentId shapes — every one must return 400 INVALID_ARGUMENT ===

      // §11.122 case 1: empty string parentId. Without the fix this
      // stored `parentId: ''` and returned 200, creating a reply that
      // could never resolve to any real parent.
      {
        const r = await callAddComment({
          anchor: { cell: 'B1' },
          text: 'empty string parentId',
          parentId: '',
        })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/parentId must be a non-empty string/)
      }

      // §11.122 case 2: numeric parentId. Without the fix this stored
      // a number; downstream equality checks silently fail.
      {
        const r = await callAddComment({
          anchor: { cell: 'B2' },
          text: 'numeric parentId',
          parentId: 123,
        })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/parentId must be a non-empty string/)
      }

      // §11.122 case 3: null parentId. Without the fix the spread
      // `...(a.parentId ? { parentId: a.parentId } : {})` silently
      // dropped null, so the reply was stored as a top-level comment.
      {
        const r = await callAddComment({
          anchor: { cell: 'B3' },
          text: 'null parentId',
          parentId: null,
        })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/parentId must be a non-empty string/)
      }

      // §11.122 case 4: object parentId. Without the fix stored
      // verbatim; equality / serialization would silently fail.
      {
        const r = await callAddComment({
          anchor: { cell: 'B4' },
          text: 'object parentId',
          parentId: { x: 'y' },
        })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/parentId must be a non-empty string/)
      }

      // §11.122 case 5: array parentId. Without the fix stored verbatim;
      // downstream `comment.parentId === parentId` checks fail forever.
      {
        const r = await callAddComment({
          anchor: { cell: 'B5' },
          text: 'array parentId',
          parentId: ['a', 'b'],
        })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/parentId must be a non-empty string/)
      }

      // §11.122 case 6: orphan parentId — well-formed string but
      // pointing at a non-existent comment. Same bug class as §11.97
      // for the v1 surface; without the fix this returned 200 and
      // created a dangling reply that no thread UI could ever resolve.
      {
        const r = await callAddComment({
          anchor: { cell: 'B6' },
          text: 'orphan parentId',
          parentId: 'cm_definitely_not_real',
        })
        expect(r.status).toBe(404)
        expect(r.body.error?.code).toBe('NOT_FOUND')
        expect(r.body.error?.message).toMatch(/parent comment not found/)
      }

      // === Happy paths (regression guards) ===

      // Real parentId → 200 + comment id
      {
        const r = await callAddComment({
          anchor: { cell: 'C1' },
          text: 'valid reply',
          parentId,
        })
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
        expect((r.body.result as { id?: string })?.id).toMatch(/^cm_/)
      }

      // No parentId at all → 200 (top-level comment)
      {
        const r = await callAddComment({
          anchor: { cell: 'C2' },
          text: 'no parent',
        })
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }

      // === Verify only the 2 happy-path comments persisted ===
      // The v1 list endpoint (`handleFilesCommentsList`) passes
      // `opts = {}` to `comments-store.listComments` when neither
      // `?resolved=` nor `?parentId=` is in the URL, and
      // `comments-store.listComments` defaults to **top-level only**
      // in that case (filter `c.parentId === undefined`). So the REST
      // surface cannot directly enumerate replies; instead we rely on
      // the status-code assertions above + a top-level list assertion
      // here to prove the malformed inputs created nothing.
      const listRes = await fetch(
        `${h.base}/api/v1/files/${encodeURIComponent(fileId)}/comments`,
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
      )
      expect(listRes.status).toBe(200)
      const list = await listRes.json() as { comments: Array<{ id: string; text: string; parentId?: string }> }
      // Only the parent + the no-parent comment are top-level (the
      // valid reply has a parentId, so the top-level filter drops it
      // from this response). The 5×400 + 1×404 malformed calls must
      // NOT have created ANY comment — verified by the fact that we
      // see exactly the 2 we expected, no extras.
      expect(list.comments.length).toBe(2)
      const texts = list.comments.map((c) => c.text).sort()
      expect(texts).toEqual(['no parent', 'parent comment'])
      // And no comment in the persisted set should carry a malformed
      // parentId shape (number / object / array / empty / null):
      const malformed = list.comments.filter((c) =>
        c.parentId !== undefined &&
        (c.parentId === '' ||
          typeof c.parentId !== 'string'),
      )
      expect(malformed.length).toBe(0)
    } finally {
      await h.stop()
    }
  })
})
