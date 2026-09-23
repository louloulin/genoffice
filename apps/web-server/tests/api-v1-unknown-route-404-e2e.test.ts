/**
 * /api/v1/* error envelope dispatch (sdk1.md §11.0 follow-up + §11.111 fix).
 *
 * Boots the real bundle via the shared `ServerHarness` helper (see
 * `helpers/v1-smoke.ts`). Pins the dispatcher behavior split between
 * two error classes:
 *
 *   - Truly unknown path → 404 NOT_FOUND (JSON).
 *   - Known path, wrong HTTP method → 405 METHOD_NOT_ALLOWED + Allow
 *     list (RFC 7231). §11.111 closes the gap where wrong-method
 *     requests previously fell through to the 404 catch-all, which is
 *     an RFC 7231 violation: "path exists, method wrong" must be 405,
 *     not 404. 404 is reserved for paths that don't exist at any
 *     method.
 *
 * Both error paths return JSON (Content-Type: application/json) so API
 * clients have a uniform error shape regardless of which 4xx fires.
 *
 * If a future refactor changes the outer dispatcher's behavior, this
 * test catches the regression at the wire level — the API client
 * receives JSON instead of HTML, and never gets 404 for an existing
 * route.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('GET /api/v1/* error envelope dispatch (sdk1 §11.0 + §11.111)', () => {
  const harness = ServerHarness

  it('serves JSON envelopes for both truly-unknown and wrong-method on existing routes', async () => {
    const h = await harness.start()
      .catch((e) => {
        throw new Error(`harness.start failed: ${e.message}`)
      })
    try {
      type Envelope = {
        error: {
          code: string
          message: string
          channel: string
          allow?: string
        }
      }

      // Sanity: a known v1 route still works correctly.
      const health = await h.req('/api/v1/health')
      expect(health.status).toBe(200)
      expect((health.body as { status: string }).status).toBe('ok')

      type Envelope = {
        error: {
          code: string
          message: string
          channel: string
          allow?: string
        }
      }
      // Admin scope bypasses all v1 scope gates (§11.106) so the test
      // exercises wrong-method dispatch independently of permissions.
      const token = await h.token('tester', ['admin'])

      // §11.111: GET /api/v1/webhooks is a known path but only POST/DELETE
      // are valid; expect 405 with the standard envelope + allow list
      // (NOT 404 — that was the bug, see §11.111 section in sdk1.md).
      const getWebhooks = await h.req<Envelope>('/api/v1/webhooks', { method: 'GET', token })
      expect(getWebhooks.status).toBe(405)
      expect(getWebhooks.headers.get('content-type')).toMatch(/^application\/json/)
      expect(getWebhooks.body.error.code).toBe('METHOD_NOT_ALLOWED')
      expect(getWebhooks.body.error.allow).toBe('POST, DELETE')
      expect(getWebhooks.body.error.channel).toBe('/api/v1/webhooks')

      // §11.111: PUT /api/v1/health (only GET is allowed) → 405 + allow=GET.
      const putHealth = await h.req<Envelope>('/api/v1/health', { method: 'PUT', token })
      expect(putHealth.status).toBe(405)
      expect(putHealth.headers.get('content-type')).toMatch(/^application\/json/)
      expect(putHealth.body.error.code).toBe('METHOD_NOT_ALLOWED')
      expect(putHealth.body.error.allow).toBe('GET')

      // §11.111: PATCH /api/v1/files (only GET/POST allowed) → 405.
      const patchFiles = await h.req<Envelope>('/api/v1/files', { method: 'PATCH', token })
      expect(patchFiles.status).toBe(405)
      expect(patchFiles.headers.get('content-type')).toMatch(/^application\/json/)
      expect(patchFiles.body.error.code).toBe('METHOD_NOT_ALLOWED')
      expect(patchFiles.body.error.allow).toBe('GET, POST')

      // Truly unknown path → still 404 NOT_FOUND (the 404 class is
      // reserved for paths that don't exist at any method).
      const unk = await h.req<Envelope>('/api/v1/this-route-does-not-exist', { method: 'GET', token })
      expect(unk.status).toBe(404)
      expect(unk.headers.get('content-type')).toMatch(/^application\/json/)
      expect(unk.body.error.code).toBe('NOT_FOUND')
      expect(unk.body.error.message).toContain('GET')
      expect(unk.body.error.message).toContain('/api/v1/this-route-does-not-exist')

      // Wrong method on the DLQ collection (§11.111 secondary fix):
      // /api/v1/webhooks/dlq only supports GET; POST/PUT/DELETE must 405.
      const postDlq = await h.req<Envelope>('/api/v1/webhooks/dlq', { method: 'POST', token })
      expect(postDlq.status).toBe(405)
      expect(postDlq.headers.get('content-type')).toMatch(/^application\/json/)
      expect(postDlq.body.error.code).toBe('METHOD_NOT_ALLOWED')
    } finally {
      await h.stop()
    }
  }, 30_000)
})
