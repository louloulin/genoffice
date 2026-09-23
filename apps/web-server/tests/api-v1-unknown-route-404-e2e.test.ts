/**
 * /api/v1/* unknown route returns 404 (sdk1.md follow-up, e2e).
 *
 * Boots the real bundle via the shared `ServerHarness` helper (see
 * `helpers/v1-smoke.ts`). Verifies the response is a JSON 404 envelope
 * rather than the SPA HTML that the static fallback would otherwise
 * serve.
 *
 * This is the e2e complement to `api-v1-unknown-route-404.test.ts`,
 * which pins the in-process `handleApiV1` contract (returns `false`
 * for unknown routes). The two together ensure:
 *
 *   - the dispatcher reliably says "I don't handle this" via `false`
 *   - the outer index.ts reliably converts that into a 404 envelope
 *     instead of letting it slip through to the static fallback
 *
 * If a future refactor changes the outer dispatcher's behavior, this
 * test catches the regression at the wire level — the API client
 * receives JSON instead of HTML.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('GET /api/v1/* unknown route (sdk1 follow-up)', () => {
  const harness = ServerHarness

  it('boots a fresh server and serves 404 JSON for unknown routes', async () => {
    const h = await harness.start()
      .catch((e) => {
        throw new Error(`harness.start failed: ${e.message}`)
      })
    try {
      // Known route still works (sanity check).
      const health = await h.req('/api/v1/health')
      expect(health.status).toBe(200)
      expect((health.body as { status: string }).status).toBe('ok')

      // GET /api/v1/webhooks is a known path; only POST/DELETE are valid.
      const wh = await h.req('/api/v1/webhooks', { method: 'GET' })
      expect(wh.status).toBe(404)
      expect(wh.headers.get('content-type')).toMatch(/application\/json/)
      const whBody = wh.body as { error: { code: string; message: string; channel: string } }
      expect(whBody.error.code).toBe('NOT_FOUND')
      expect(whBody.error.message).toContain('GET')
      expect(whBody.error.message).toContain('/api/v1/webhooks')
      expect(whBody.error.channel).toBe('/api/v1/webhooks')

      // Truly unknown path.
      const unk = await h.req('/api/v1/this-route-does-not-exist', { method: 'GET' })
      expect(unk.status).toBe(404)
      expect(unk.headers.get('content-type')).toMatch(/application\/json/)
      expect((unk.body as { error: { code: string } }).error.code).toBe('NOT_FOUND')

      // Wrong method on a known path.
      const putHealth = await h.req('/api/v1/health', { method: 'PUT' })
      expect(putHealth.status).toBe(404)
      expect(putHealth.headers.get('content-type')).toMatch(/application\/json/)

      // Wrong method on the files endpoint (GET/POST only).
      const patchFiles = await h.req('/api/v1/files', { method: 'PATCH' })
      expect(patchFiles.status).toBe(404)
      expect(patchFiles.headers.get('content-type')).toMatch(/application\/json/)
    } finally {
      await h.stop()
    }
  }, 30_000)
})
