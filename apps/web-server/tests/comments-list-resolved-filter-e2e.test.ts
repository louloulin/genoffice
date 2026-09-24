/**
 * Comments list `?resolved=` strict-filter validation (sdk1 §11.120).
 *
 * Pins the boundary that `GET /api/v1/files/:id/comments?resolved=...`
 * accepts only exact `'true'` / `'false'` (or omitted / empty). Any
 * other value is rejected as 400 INVALID_ARGUMENT, not silently
 * treated as "no filter".
 *
 * The previous behavior silently fell through:
 *   - `?resolved=TRUE`     → all comments (host expects resolved-only)
 *   - `?resolved=1`        → all comments (host expects resolved-only)
 *   - `?resolved=yes`      → all comments (host expects resolved-only)
 *   - `?resolved=invalid`  → all comments (host expects ???)
 * Hosts that typo'd "TRUE" instead of "true" got all comments back
 * with no signal that the filter was ignored — same class of
 * "explicit caller error masquerading as success" that §11.116
 * closed for KB `?limit=1.5`.
 *
 * Empty string `?resolved=` and omitted param still mean "no filter"
 * (same convention as §11.115 null doc / §11.117 events:null).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

// Each tuple: [label, value, expectedCount]. `null` for value means
// "omit the param entirely". Empty string is its own case.
const FILTER_CASES: ReadonlyArray<readonly [string, string | null, number]> = [
  ['exact true', 'true', 1],
  ['exact false', 'false', 2],
  ['uppercase TRUE', 'TRUE', 0], // 400 — not accepted
  ['numeric 1', '1', 0], // 400 — not accepted
  ['numeric 0', '0', 0], // 400 — not accepted
  ['yes', 'yes', 0], // 400 — not accepted
  ['no', 'no', 0], // 400 — not accepted
  ['invalid string', 'invalid', 0], // 400 — not accepted
  ['mixed case True', 'True', 0], // 400 — case-sensitive
  ['JSON null', 'null', 0], // 400 — not a valid boolean string
  ['empty (treated as omitted)', '', 3], // 200 — all comments
  ['omitted (no param)', null, 3], // 200 — all comments
]

describe.skipIf(skip)('comments list ?resolved= strict filter (sdk1 §11.120)', () => {
  it('accepts exact true/false (or omitted/empty), rejects any other value with 400', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('comments-list-tester', ['files:read', 'files:comment', 'admin'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }

    let realFileId = ''
    try {
      // ── Set up: create a real file and add 3 comments (1 resolved, 2 unresolved) ──
      const bytes = Buffer.from('comments list resolved filter test\n', 'utf8')
      const create = await h.req<{ id: string }>('/api/v1/files', {
        ...authPost,
        body: JSON.stringify({ name: 'resolved-filter-test.md', bytes: bytes.toString('base64') }),
      })
      expect(create.status).toBe(201)
      realFileId = create.body.id

      // Comment 1: stays unresolved
      const c1 = await h.req<{ comment: { id: string } }>(`/api/v1/files/${realFileId}/comments`, {
        ...authPost,
        body: JSON.stringify({ anchor: { x: 1 }, text: 'c1-unresolved' }),
      })
      expect(c1.status).toBe(201)

      // Comment 2: gets resolved
      const c2 = await h.req<{ comment: { id: string } }>(`/api/v1/files/${realFileId}/comments`, {
        ...authPost,
        body: JSON.stringify({ anchor: { x: 2 }, text: 'c2-resolved' }),
      })
      expect(c2.status).toBe(201)
      const resolve = await h.req(`/api/v1/files/${realFileId}/comments/${c2.body.comment.id}`, {
        method: 'PATCH',
        token,
        headers,
        body: JSON.stringify({ resolved: true }),
      })
      expect(resolve.status).toBe(200)

      // Comment 3: stays unresolved
      const c3 = await h.req<{ comment: { id: string } }>(`/api/v1/files/${realFileId}/comments`, {
        ...authPost,
        body: JSON.stringify({ anchor: { x: 3 }, text: 'c3-unresolved' }),
      })
      expect(c3.status).toBe(201)

      // ── Phase 1: walk every filter case ────────────────────────────────
      for (const [label, value, expectedCount] of FILTER_CASES) {
        const path = value === null
          ? `/api/v1/files/${realFileId}/comments`
          : `/api/v1/files/${realFileId}/comments?resolved=${encodeURIComponent(value)}`
        const r = await h.req<{ count?: number; error?: { code: string } }>(path, { token })

        if (expectedCount === 0) {
          // Strict rejection — 400 INVALID_ARGUMENT
          expect(r.status, `${label} (value=${JSON.stringify(value)}) status`).toBe(400)
          expect(
            (r.body as { error: { code: string } }).error?.code,
            `${label} (value=${JSON.stringify(value)}) code`,
          ).toBe('INVALID_ARGUMENT')
        } else {
          // Permissive — 200 with the expected count
          expect(r.status, `${label} (value=${JSON.stringify(value)}) status`).toBe(200)
          expect(r.body.count, `${label} (value=${JSON.stringify(value)}) count`).toBe(expectedCount)
        }
      }

      // ── Phase 2: server still healthy after the bad-input storm ───────
      const health = await h.req<{ status: string }>('/health')
      expect(health.status).toBe(200)
    } finally {
      await h.stop()
    }
  }, 60_000)
})
