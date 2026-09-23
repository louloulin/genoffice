/**
 * End-to-end contract pin for HTTP method + error envelope consistency
 * (sdk1.md §11.107).
 *
 * Pins the boundary added by the §11.107 fix:
 *
 *   - `GET /api/channels` was the only documented method; POST fell through
 *     to the SPA fallback and returned `200 + index.html`, which is
 *     indistinguishable from a successful render to API clients. Now
 *     POST returns `405` with a structured `{error:{code, message, channel,
 *     allow}}` envelope.
 *
 *   - `POST /api/ai/pi-prompt` was the only documented method; GET fell
 *     through to the SPA fallback (HTML). Now GET returns 405.
 *
 *   - `/api/ai/pi-prompt` error responses (invalid JSON, empty text)
 *     previously returned `{ok:false, error:"pi-prompt: ..."}` — a
 *     different shape than every other v1 + legacy endpoint which uses
 *     `{error:{code, message, channel}}`. Now aligned with the v1
 *     envelope so callers can branch on `error.code` consistently.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 HTTP method + envelope contract', () => {
  it('walks wrong-method 405 + envelope branches', async () => {
    const h = await ServerHarness.start()
    try {
      // ── /api/channels ───────────────────────────────────────────────────
      // 1. GET (regression) → 200 + protocol version
      {
        const r = await h.req<{ protocolVersion: number; channels: string[] }>(
          '/api/channels',
        )
        expect(r.status).toBe(200)
        expect(r.body.protocolVersion).toBe(1)
        expect(Array.isArray(r.body.channels)).toBe(true)
        expect(r.body.channels.length).toBeGreaterThan(0)
      }

      // 2. POST → 405 with structured envelope
      {
        const r = await h.req<{ error: { code: string; message: string; channel: string; allow: string } }>(
          '/api/channels',
          { method: 'POST' },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
        expect(r.body.error.allow).toBe('GET')
        expect(r.body.error.channel).toBe('/api/channels')
        // Content-Type must be JSON, NOT HTML
        expect(r.headers.get('content-type')).toMatch(/^application\/json/)
      }

      // 3. PUT → 405 (any non-GET method)
      {
        const r = await h.req<{ error: { code: string } }>('/api/channels', {
          method: 'PUT',
        })
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // ── /api/ai/pi-prompt ───────────────────────────────────────────────
      // 4. GET → 405
      {
        const r = await h.req<{ error: { code: string; allow: string } }>(
          '/api/ai/pi-prompt',
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
        expect(r.body.error.allow).toBe('POST')
      }

      // 5. PUT → 405
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/ai/pi-prompt',
          { method: 'PUT' },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // 6. POST with invalid JSON → 400 with v1 envelope
      {
        const r = await h.req<{ error: { code: string; message: string; channel: string } }>(
          '/api/ai/pi-prompt',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: 'not-json',
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('invalid JSON')
        expect(r.body.error.channel).toBe('/api/ai/pi-prompt')
      }

      // 7. POST with empty body → 400 with v1 envelope
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/ai/pi-prompt',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('empty text')
      }

      // ── /api/ai/languages regression: was already 405, stay 405 ─────────
      // 8. POST → 405 (regression check, format unchanged)
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/ai/languages',
          { method: 'POST' },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // 9. GET → 200 + languages list (regression)
      {
        const r = await h.req<{ ok: boolean; languages: { value: string }[] }>(
          '/api/ai/languages',
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(Array.isArray(r.body.languages)).toBe(true)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
