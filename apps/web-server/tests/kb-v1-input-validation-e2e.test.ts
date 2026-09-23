/**
 * End-to-end contract pin for `/api/v1/kb/search` and `/api/v1/kb/entries`
 * input validation (sdk1 §11.116).
 *
 * Pins the §11.116 fixes. The KB REST shim previously forwarded `limit`
 * and `schema` straight to the underlying IPC tool with only the loosest
 * sanity checks (`< 1` / non-numeric for limit, none for schema):
 *
 *   - `?limit=1.5` (non-integer) → 200 with `{ok:false, error:'kb_search:
 *     `limit` must be an integer between 1 and 100 (got 1.5)'}`.
 *   - `?limit=101..1000` (above the IPC's real cap of 100 for search) →
 *     same `{ok:false}` leak. The REST layer clamped to 1000 while the
 *     IPC tool's own contract is 1..100.
 *   - `?schema=nonsense` on `/kb/entries` → the IPC answered
 *     `{ok:false, error:'kb_list: unknown schema …'}` with a 200.
 *
 * All three are the §11.103/§11.112/§11.115 IPC-shape-leak class: a 200
 * response that is not a real success. The fix mirrors the IPC contract
 * exactly at the REST layer (integer for limit, integer 1..100 for
 * search, integer 1..1000 for entries, and the five known `schema` keys
 * for entries) and rejects any other shape with 400 INVALID_ARGUMENT.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, mintJwt } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface Envelope {
  error?: { code?: string; message?: string; channel?: string }
}
interface SearchBody {
  ok?: boolean
  details?: { entries?: unknown[] }
  error?: string
}

describe.skipIf(skip)('kb v1 input validation (sdk1 §11.116)', () => {
  it('rejects non-integer / out-of-range limit and unknown schema with 400', async () => {
    const h = await ServerHarness.start()
    try {
      const token = await mintJwt(h.secret, 'tester', ['admin'])

      // ── Phase 1: kb/search limit must be integer 1..100 ───────────
      // Non-integer: previously 200 + `{ok:false}` leak.
      for (const l of ['1.5', '0.001', '-1', '0', 'abc', 'NaN', 'Infinity']) {
        const r = await h.req<Envelope>(`/api/v1/kb/search?q=test&limit=${encodeURIComponent(l)}`, { token })
        expect(r.status, `limit=${l} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      // Above-cap: previously clamped to 1000 → IPC rejected → 200 +
      // `{ok:false}`. Must now be a real 200 (clamped to 100) since the
      // IPC will accept the clamped value.
      for (const l of ['101', '500', '1000', '999999']) {
        const r = await h.req<SearchBody>(`/api/v1/kb/search?q=test&limit=${l}`, { token })
        expect(r.status, `limit=${l} must 200`).toBe(200)
        expect(r.body.ok, `limit=${l} must ok=true (not ok:false IPC leak)`).toBe(true)
      }
      // In-range happy paths.
      const ok = await h.req<SearchBody>('/api/v1/kb/search?q=test&limit=10', { token })
      expect(ok.status).toBe(200)
      expect(ok.body.ok).toBe(true)

      // ── Phase 2: kb/entries limit must be integer 1..1000 ─────────
      for (const l of ['1.5', '-3', '0', 'abc', 'NaN']) {
        const r = await h.req<Envelope>(`/api/v1/kb/entries?limit=${encodeURIComponent(l)}`, { token })
        expect(r.status, `limit=${l} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      for (const l of ['1', '50', '100', '1000', '999999']) {
        const r = await h.req<{ ok?: boolean }>(`/api/v1/kb/entries?limit=${l}`, { token })
        expect(r.status, `limit=${l} must 200`).toBe(200)
        expect(r.body.ok, `limit=${l} must ok=true (not ok:false IPC leak)`).toBe(true)
      }

      // ── Phase 3: kb/entries schema must be one of the five keys ────
      // Empty / whitespace schemas are the JSON idiom for "not set" — the
      // REST layer treats them as no-filter (200 + unfiltered list),
      // matching the `null` doc/scope convention in §11.115.
      for (const schema of ['nonsense', 'unknown', 'term,forbidden', 'term ']) {
        const r = await h.req<Envelope>(`/api/v1/kb/entries?schema=${encodeURIComponent(schema)}`, { token })
        expect(r.status, `schema=${JSON.stringify(schema)} must 400`).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
      }
      for (const schema of ['term', 'forbidden', 'brand', 'styleRule', 'customerPreference']) {
        const r = await h.req<{ ok?: boolean }>(`/api/v1/kb/entries?schema=${schema}`, { token })
        expect(r.status, `schema=${schema} must 200`).toBe(200)
        expect(r.body.ok, `schema=${schema} must ok=true`).toBe(true)
      }

      // ── Phase 4: missing schema is fine (no filter) ───────────────
      const noSchema = await h.req<{ ok?: boolean }>('/api/v1/kb/entries', { token })
      expect(noSchema.status).toBe(200)
      expect(noSchema.body.ok).toBe(true)

      // ── Phase 5: server survived all the rejected bad payloads ─────
      const health = await h.req('/health')
      expect(health.status).toBe(200)
    } finally {
      await h.stop()
    }
  })
})
