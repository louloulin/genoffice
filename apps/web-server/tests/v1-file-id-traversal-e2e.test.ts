/**
 * End-to-end contract pin for the v1 `:id` path-traversal refusal (sdk1 §11.114).
 *
 * Pins the §11.114 fix. Every `:id` route in the v1 shim joins the raw
 * (percent-decoded) path segment onto `FILES_DIR`:
 *
 *     const target = join(FILES_DIR, id)
 *
 * Before the fix there was no containment check, so a percent-encoded
 * traversal in the `:id` segment escaped managed storage and the versions
 * surface became an arbitrary-file-read primitive:
 *
 *     POST /api/v1/files/..%2Fwebhooks.json/versions   → 201 (snapshot taken)
 *     GET  /api/v1/files/..%2Fwebhooks.json/versions   → lists the snapshot
 *     GET  /api/v1/files/..%2Fwebhooks.json/versions/v-webhooks.json-1
 *                                                      → 200 + base64 bytes
 *
 * The leaked target was any readable path (`/etc/*`) *and* DATA_DIR
 * siblings such as `webhooks.json` / `webhooks-dlq.json` (HMAC signing
 * secrets) that live one level above `FILES_DIR`. The IPC surface already
 * refused this via `requireManagedPath`; only the v1 shim bypassed it.
 *
 * This test locks the refusal at the REST layer for every route that
 * consumes a `:id` segment, and — critically — proves the traversal does
 * NOT create a snapshot directory on disk and does NOT leak bytes.
 *
 * Second bug pinned here (same commit): a malformed percent escape in a
 * decoded segment (`/api/v1/files/%/comments`) threw `URIError` past the
 * dispatcher and surfaced as `500 {"error":{"message":"URI malformed"}}`
 * with no `code`/`channel`. Bad encoding is the caller's fault → 400
 * `INVALID_ARGUMENT` with the standard envelope.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, mintJwt } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

// `..%2Fwebhooks.json` decodes to `../webhooks.json` — a DATA_DIR sibling
// that holds HMAC signing secrets. `..%2F..%2F..%2Fetc%2Fhosts` escapes
// DATA_DIR entirely.
const SIBLING_TRAVERSAL = '..%2Fwebhooks.json'
const ETC_TRAVERSAL = '..%2F..%2F..%2F..%2Fetc%2Fhosts'

interface Envelope {
  error?: { code?: string; message?: string; channel?: string }
}

describe.skipIf(skip)('v1 file :id path traversal refusal (sdk1 §11.114)', () => {
  it('refuses traversal / malformed-encoding ids on every :id route', async () => {
    const h = await ServerHarness.start()
    try {
      const token = await mintJwt(h.secret, 'attacker', ['admin'])

      // ── Phase 1: GET routes must 400, not read disk ───────────────
      const getRoutes = [
        `/api/v1/files/${SIBLING_TRAVERSAL}`,
        `/api/v1/files/${SIBLING_TRAVERSAL}/comments`,
        `/api/v1/files/${SIBLING_TRAVERSAL}/versions`,
        `/api/v1/files/${ETC_TRAVERSAL}/versions`,
      ]
      for (const path of getRoutes) {
        const r = await h.req<Envelope>(path, { token })
        expect(r.status, `${path} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.headers.get('content-type')).toContain('application/json')
      }

      // ── Phase 2: the traversal snapshot must NOT have been created ──
      // This is the assertion that proves there is no side effect: even
      // if a future regression made the response 400 but still wrote the
      // snapshot, this catches it.
      const versionsDir = join(h.dataDir, 'versions')
      const sibDir = join(versionsDir, 'webhooks.json')
      expect(existsSync(sibDir), 'traversal must not create a snapshot dir').toBe(false)

      // ── Phase 3: POST routes must 400 before touching the filesystem ──
      const postCases: Array<[string, unknown]> = [
        [`/api/v1/files/${SIBLING_TRAVERSAL}/versions`, { label: 'pwn' }],
        [`/api/v1/files/${SIBLING_TRAVERSAL}/callback`, { url: 'http://127.0.0.1:1/x' }],
        [`/api/v1/files/${SIBLING_TRAVERSAL}/comments`, { anchor: { cell: 'A1' }, text: 'x' }],
        [`/api/v1/files/${SIBLING_TRAVERSAL}/versions/v-x-1/restore`, {}],
      ]
      for (const [path, body] of postCases) {
        const r = await h.req<Envelope>(path, {
          method: 'POST',
          token,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        expect(r.status, `${path} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }

      // `POST .../jwt` with a traversal id must also refuse (it would
      // otherwise mint a token whose `doc` claim points outside storage).
      const jwtR = await h.req<Envelope>(`/api/v1/files/${SIBLING_TRAVERSAL}/jwt`, {
        method: 'POST',
        token,
      })
      expect(jwtR.status).toBe(400)
      expect(jwtR.body.error?.code).toBe('INVALID_ARGUMENT')

      // DELETE via the item route (matchId() only matches a single
      // segment, so use the sibling form that decodeURIComponent splits).
      const delR = await h.req<Envelope>(`/api/v1/files/${SIBLING_TRAVERSAL}`, {
        method: 'DELETE',
        token,
      })
      expect(delR.status).toBe(400)
      expect(delR.body.error?.code).toBe('INVALID_ARGUMENT')

      // Still no snapshot dir after the whole sweep.
      expect(existsSync(sibDir)).toBe(false)
      // And the version store root exists but is otherwise empty.
      if (existsSync(versionsDir)) {
        const docs = readdirSync(versionsDir)
        expect(docs).not.toContain('webhooks.json')
        expect(docs).not.toContain('hosts')
      }

      // ── Phase 3b: whitespace-only / NUL ids also refused ──────────
      for (const path of ['/api/v1/files/%20/comments', '/api/v1/files/%00abc/comments', '/api/v1/files/%09/versions']) {
        const r = await h.req<Envelope>(path, { token })
        expect(r.status, `${path} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }

      // ── Phase 4: malformed percent-encoding → 400, not 500 ────────
      for (const path of [
        '/api/v1/files/%/comments',
        '/api/v1/files/%/versions',
        '/api/v1/files/%/jwt',
      ]) {
        const method = path.endsWith('/jwt') ? 'POST' : 'GET'
        const r = await h.req<Envelope>(path, { method, token })
        expect(r.status, `${path} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        // The old bug leaked `{message:"URI malformed"}` with no code.
        expect(r.body.error?.message ?? '').not.toContain('URI malformed')
      }

      // The server must still be alive and answering after all the
      // malformed requests (the pre-§11.108 500-class kill-the-process
      // bug is what this guards against).
      const health = await h.req('/health')
      expect(health.status).toBe(200)

      // ── Phase 5: legitimate ids still work (no over-blocking) ──────
      // A normal upload + version snapshot must still succeed so the
      // containment check is proven to be a guard, not a blanket refusal.
      const up = await h.req<{ id: string }>('/api/v1/files', {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'legit.txt', bytes: Buffer.from('hello').toString('base64') }),
      })
      expect(up.status).toBe(201)
      const fileId = up.body.id
      expect(fileId).toBeTruthy()

      const snap = await h.req<{ id: string }>(`/api/v1/files/${encodeURIComponent(fileId)}/versions`, {
        method: 'POST',
        token,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'ok' }),
      })
      expect(snap.status).toBe(201)
      expect(snap.body.id).toBeTruthy()

      const list = await h.req<{ count: number }>(`/api/v1/files/${encodeURIComponent(fileId)}/versions`, {
        token,
      })
      expect(list.status).toBe(200)
      expect(list.body.count).toBe(1)
    } finally {
      await h.stop()
    }
  })
})
