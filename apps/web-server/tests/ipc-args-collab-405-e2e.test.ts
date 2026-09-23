/**
 * End-to-end contract pin for /api/ipc args validation + /api/collab/sessions 405
 * (sdk1.md §11.108).
 *
 * Pins the boundary added by the §11.108 fix:
 *
 *   - `POST /api/ipc/:channel` previously cast `parsed.args ?? []` to
 *     `unknown[]` and called `.map(...)` on it; a caller-supplied
 *     `{"args":"not-an-array"}` would throw `args.map is not a function`
 *     and bubble up as 500 INTERNAL with an internal JS error message
 *     leaking implementation details. Now `args` is validated to be
 *     `undefined` or `Array.isArray()`; non-array values return a
 *     clean 400 with the channel-bound INVALID_ARGUMENT envelope.
 *
 *   - `POST /api/collab/sessions` (and PUT / DELETE) previously fell
 *     through to the SPA static fallback and returned `200 + <!doctype
 *     html>`. Now wrong-method requests return 405 with the structured
 *     envelope (`code: METHOD_NOT_ALLOWED`, `allow: GET`).
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 /api/ipc args + /api/collab/sessions 405', () => {
  it('walks IPC args validation + collab method gate branches', async () => {
    const h = await ServerHarness.start()
    const headers = { 'content-type': 'application/json' }

    try {
      // ── /api/ipc/:channel args validation ─────────────────────────────
      // 1. args: 'not-an-array' → 400 + clean message (was 500 + internal error)
      {
        const r = await h.req<{ error: { code: string; message: string; channel: string } }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: 'not-an-array' }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('`args` must be an array')
        expect(r.body.error.channel).toBe('home:ai-capabilities')
      }

      // 2. args: null → 400 (same)
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: null }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // 3. args: {} (object) → 400
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: {} }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // 4. args: 42 (number) → 400
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: 42 }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // 5. args missing → 200 (defaults to [] — backwards compat)
      {
        const r = await h.req<{ ok: boolean; result: unknown }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({}) },
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }

      // 6. args: [] → 200 (regression)
      {
        const r = await h.req<{ ok: boolean }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: [] }) },
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }

      // 7. args: valid array → 200 (regression)
      {
        const r = await h.req<{ ok: boolean }>(
          '/api/ipc/home:ai-capabilities',
          { method: 'POST', headers, body: JSON.stringify({ args: ['x'] }) },
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }

      // ── /api/collab/sessions method gate ───────────────────────────────
      // 8. POST → 405
      {
        const r = await h.req<{ error: { code: string; allow: string; channel: string } }>(
          '/api/collab/sessions',
          { method: 'POST', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
        expect(r.body.error.allow).toBe('GET')
        expect(r.body.error.channel).toBe('/api/collab/sessions')
        // Content-Type must be JSON, NOT HTML
        expect(r.headers.get('content-type')).toMatch(/^application\/json/)
      }

      // 9. PUT → 405
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/collab/sessions',
          { method: 'PUT', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // 10. DELETE → 405
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/collab/sessions',
          { method: 'DELETE', headers },
        )
        expect(r.status).toBe(405)
        expect(r.body.error.code).toBe('METHOD_NOT_ALLOWED')
      }

      // 11. GET → 200 (regression: empty sessions array)
      {
        const r = await h.req<{ sessions: unknown[] }>('/api/collab/sessions')
        expect(r.status).toBe(200)
        expect(Array.isArray(r.body.sessions)).toBe(true)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
