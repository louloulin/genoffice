/**
 * End-to-end lifecycle for the v1 KB search + entries surface
 * (sdk1.md §B.5.1 #3 follow-up · §11.100).
 *
 * Walks the full happy + IP-auth boundary:
 *
 *   - GET   /api/v1/kb/search?q=...&limit=...   returns matching entries
 *   - GET   /api/v1/kb/entries?schema=term&limit= returns filtered entries
 *
 * Plus auth / scope / input-validation contracts:
 *   - 401 on missing JWT
 *   - 403 on missing kb:read
 *   - 400 on missing q
 *   - 400 on invalid limit (non-numeric / negative / 0)
 *
 * This test pins the contract fix introduced by §11.100:
 * the REST `kb:search` previously called `ai:translation-kb-resolve`
 * with `{ term, limit }`, but that IPC is a language-pair resolver that
 * requires `targetLang` and doesn't recognize `term`. Every kb:search
 * call returned `{ ok: false, error: "expected non-empty 'targetLang'" }`.
 *
 * The fix routes through `home:translate-kb-search` (proxies to
 * `kb_search` tool with `{ query, limit }`) — the IPC that matches the
 * REST contract.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 KB search + entries lifecycle', () => {
  it('walks search + entries + auth / scope / input-validation branches', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('kb-tester', ['kb:read', 'admin'])
    const noKbRead = await h.token('no-kb-read', ['webhooks:manage'])

    try {
      // ── 1. KB search returns at least the seed entry for "fabric" ────────
      {
        const r = await h.req<{ ok: boolean; details?: { entries?: unknown[]; count?: number } }>(
          '/api/v1/kb/search?q=fabric&limit=5',
          { token },
        )
        // The exact seed corpus varies per test env, so just assert the
        // contract: the IPC `kb_search` returns `{ ok, details: { entries, count } }`,
        // and we expect a non-zero count for "fabric" (the seed KB has
        // fabric / 克重 / GSM entries from the e2e corpus).
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
        expect((r.body.details?.count ?? 0) > 0).toBe(true)
      }

      // ── 2. KB search with limit clamp ────────────────────────────────────
      {
        const r = await h.req<{ ok: boolean; details?: { count?: number } }>(
          '/api/v1/kb/search?q=fabric&limit=1',
          { token },
        )
        expect(r.status).toBe(200)
        expect(r.body.details?.count).toBeLessThanOrEqual(1)
      }

      // ── 3. KB search limit > 1000 is clamped ─────────────────────────────
      {
        const r = await h.req<{ ok: boolean }>(
          '/api/v1/kb/search?q=fabric&limit=99999',
          { token },
        )
        // Should not crash; clamped internally
        expect(r.status).toBe(200)
      }

      // ── 4. KB entries with schema filter returns just term entries ───────
      {
        const r = await h.req<{ ok: boolean; entries?: unknown[] }>(
          '/api/v1/kb/entries?schema=term&limit=5',
          { token },
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(Array.isArray(r.body.entries)).toBe(true)
      }

      // ── 5. KB entries with no filter returns all entries ────────────────
      {
        const r = await h.req<{ ok: boolean; entries?: unknown[] }>(
          '/api/v1/kb/entries?limit=5',
          { token },
        )
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
        expect(Array.isArray(r.body.entries)).toBe(true)
      }

      // ── NEGATIVE: missing q → 400 ────────────────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search', { token })
        expect(r.status).toBe(400)
        expect((r.body as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
      }

      // ── NEGATIVE: negative limit → 400 ───────────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search?q=x&limit=-1', { token })
        expect(r.status).toBe(400)
      }

      // ── NEGATIVE: non-numeric limit → 400 ────────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search?q=x&limit=abc', { token })
        expect(r.status).toBe(400)
      }

      // ── NEGATIVE: zero limit → 400 ───────────────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search?q=x&limit=0', { token })
        expect(r.status).toBe(400)
      }

      // ── NEGATIVE: No JWT → 401 ───────────────────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search?q=x')
        expect(r.status).toBe(401)
      }

      // ── NEGATIVE: token without kb:read → 403 ────────────────────────────
      {
        const r = await h.req('/api/v1/kb/search?q=x', { token: noKbRead })
        expect(r.status).toBe(403)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
