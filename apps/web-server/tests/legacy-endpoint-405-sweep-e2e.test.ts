/**
 * End-to-end contract pin for wrong-method 405 across the remaining
 * legacy / non-v1 endpoints (sdk1.md §11.110).
 *
 * Pins the boundary added by the §11.110 fix — 7 endpoints had the
 * same SPA-fallback bug as §11.107/§11.108/§11.109 but were missed in
 * those rounds:
 *
 *   - GET /health (POST/DELETE returned 200 + <!doctype html>)
 *   - GET /api/ipc/events (POST/PUT returned 200 + HTML)
 *   - POST /api/ai/stream (GET/PUT returned 200 + HTML)
 *   - POST /api/ai/stream/cancel (GET returned 200 + HTML)
 *   - POST /api/ai/translate (non-v1 batch; GET returned 200 + HTML)
 *   - POST /api/ai/translate/stream (SSE; GET returned 200 + HTML)
 *   - POST /api/ai/translate/stream/cancel (GET returned 200 + HTML)
 *
 * All seven now return 405 + structured envelope with `Allow:` per RFC 7231.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 legacy endpoint 405 sweep (§11.110)', () => {
  it('walks wrong-method 405 + GET regression across 7 endpoints', async () => {
    const h = await ServerHarness.start()
    try {
      // Each entry: [path, expectedMethod, expectedAllow, regressionMethod]
      const cases: [string, 'GET' | 'POST', 'GET' | 'POST', 'GET' | 'POST'][] = [
        ['/health', 'GET', 'GET', 'POST'],
        ['/api/ipc/events', 'GET', 'GET', 'POST'],
        ['/api/ai/stream', 'POST', 'POST', 'GET'],
        ['/api/ai/stream/cancel', 'POST', 'POST', 'GET'],
        ['/api/ai/translate', 'POST', 'POST', 'GET'],
        ['/api/ai/translate/stream', 'POST', 'POST', 'GET'],
        ['/api/ai/translate/stream/cancel', 'POST', 'POST', 'GET'],
      ]

      for (const [path, expectedMethod, expectedAllow, wrongMethod] of cases) {
        // 1. wrong method → 405
        const wrongRes = await h.req<{
          error: { code: string; message: string; allow: string; channel: string }
        }>(path, { method: wrongMethod })
        expect(wrongRes.status, `${path} ${wrongMethod}`).toBe(405)
        expect(wrongRes.body.error.code, `${path} ${wrongMethod}`).toBe('METHOD_NOT_ALLOWED')
        expect(wrongRes.body.error.allow, `${path} ${wrongMethod}`).toBe(expectedAllow)
        expect(wrongRes.body.error.channel, `${path} ${wrongMethod}`).toBe(path)
        // Content-Type must be JSON
        expect(wrongRes.headers.get('content-type'), `${path} ${wrongMethod}`).toMatch(
          /^application\/json/,
        )

        // 2. correct method → NOT 405 (regression: still works)
        // For SSE endpoints (translate/stream/cancel/pi-prompt), we just
        // assert the status is not 405; the body shape varies.
        const okRes = await h.req(path, { method: expectedMethod })
        expect(okRes.status, `${path} ${expectedMethod} regression`).not.toBe(405)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
