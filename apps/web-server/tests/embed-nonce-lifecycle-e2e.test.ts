/**
 * End-to-end lifecycle for the v1 embed nonce surface
 * (sdk1.md §11.26 / §11.20.5).
 *
 * Walks the full nonce ↔ session binding flow:
 *
 *   - POST   /api/v1/embed/nonce          mint a session + nonce for docId
 *   - POST   /api/v1/embed/verify-nonce   confirm valid session/nonce pair
 *   - DELETE /api/v1/embed/nonce          release the session
 *   - POST   /api/v1/embed/verify-nonce   released → invalid
 *
 * Plus auth / scope / input-validation contracts:
 *   - 401 on missing JWT
 *   - 403 on missing files:read
 *   - 400 on missing docId / negative ttlMs / non-numeric ttlMs
 *   - MAX_TTL_MS cap: ttlMs > 1h is silently clamped (no 400)
 *   - unknown sessionId is invalid (verify) / not released (delete)
 *
 * The sessionId and nonce are equal in this implementation
 * (single-token, opaque). The test pins that equality too.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface MintResp {
  sessionId: string
  nonce: string
  expiresAt: number
  ttlMs: number
}

describe.skipIf(skip)('v1 embed nonce lifecycle', () => {
  it('walks mint → verify → release → verify-after-release', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('embed-tester', ['files:read'])
    // hasScope() defaults to files:read when scope claim is empty, so
    // use a token with an unrelated scope to prove the gate actually
    // denies on missing files:read.
    const noFilesRead = await h.token('no-files-read', ['webhooks:manage'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }
    const authDel = { token, method: 'DELETE' as const, headers }

    try {
      // ── 1. Mint ──────────────────────────────────────────────────────────
      const mint = await h.req<MintResp>('/api/v1/embed/nonce', {
        ...authPost,
        body: JSON.stringify({ docId: 'embed-doc-1', ttlMs: 60_000 }),
      })
      expect(mint.status).toBe(200)
      expect(mint.body.sessionId).toBeTruthy()
      expect(mint.body.nonce).toBe(mint.body.sessionId) // sessionId === nonce in this impl
      expect(mint.body.ttlMs).toBe(60_000)
      expect(mint.body.expiresAt).toBeGreaterThan(Date.now())

      const sid = mint.body.sessionId
      const nonce = mint.body.nonce

      // ── 2. Verify valid ───────────────────────────────────────────────────
      {
        const r = await h.req<{ valid: boolean; expiresAt?: number; reason?: string }>(
          '/api/v1/embed/verify-nonce',
          {
            ...authPost,
            body: JSON.stringify({ sessionId: sid, nonce }),
          },
        )
        expect(r.status).toBe(200)
        expect(r.body.valid).toBe(true)
        expect(r.body.expiresAt).toBe(mint.body.expiresAt)
      }

      // ── 3. Verify with wrong nonce → invalid (the binding is what protects) ─
      {
        const r = await h.req<{ valid: boolean; reason?: string }>(
          '/api/v1/embed/verify-nonce',
          {
            ...authPost,
            body: JSON.stringify({ sessionId: sid, nonce: 'definitely-not-the-real-one' }),
          },
        )
        expect(r.status).toBe(200)
        expect(r.body.valid).toBe(false)
        expect(r.body.reason).toBe('unknown')
      }

      // ── 4. Release ─────────────────────────────────────────────────────────
      {
        const r = await h.req<{ released: boolean }>('/api/v1/embed/nonce', {
          ...authDel,
          body: JSON.stringify({ sessionId: sid }),
        })
        expect(r.status).toBe(200)
        expect(r.body.released).toBe(true)
      }

      // ── 5. Verify after release → invalid ─────────────────────────────────
      {
        const r = await h.req<{ valid: boolean; reason?: string }>(
          '/api/v1/embed/verify-nonce',
          {
            ...authPost,
            body: JSON.stringify({ sessionId: sid, nonce }),
          },
        )
        expect(r.status).toBe(200)
        expect(r.body.valid).toBe(false)
        expect(r.body.reason).toBe('unknown')
      }

      // ── 6. Release unknown sessionId → released:false (no error) ─────────
      {
        const r = await h.req<{ released: boolean }>('/api/v1/embed/nonce', {
          ...authDel,
          body: JSON.stringify({ sessionId: 'unknown-sid-does-not-exist' }),
        })
        expect(r.status).toBe(200)
        expect(r.body.released).toBe(false)
      }

      // ── 7. Missing docId on mint → 400 ───────────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          ...authPost,
          body: JSON.stringify({ ttlMs: 60_000 }),
        })
        expect(r.status).toBe(400)
        expect((r.body as { error: { code: string } }).error.code).toBe('BAD_REQUEST')
      }

      // ── 8. Empty docId → 400 ─────────────────────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          ...authPost,
          body: JSON.stringify({ docId: '   ' }),
        })
        expect(r.status).toBe(400)
      }

      // ── 9. Negative ttlMs → 400 ─────────────────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          ...authPost,
          body: JSON.stringify({ docId: 'x', ttlMs: -1 }),
        })
        expect(r.status).toBe(400)
      }

      // ── 10. Non-numeric ttlMs → 400 ──────────────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          ...authPost,
          body: JSON.stringify({ docId: 'x', ttlMs: 'abc' }),
        })
        expect(r.status).toBe(400)
      }

      // ── 11. ttlMs > MAX_TTL_MS (1h) → silently clamped to 1h ─────────────
      {
        const r = await h.req<MintResp>('/api/v1/embed/nonce', {
          ...authPost,
          body: JSON.stringify({ docId: 'clamp-test', ttlMs: 86_400_000 }), // 24h, way over
        })
        expect(r.status).toBe(200)
        expect(r.body.ttlMs).toBe(60 * 60 * 1000) // 1h cap
      }

      // ── 12. No JWT → 401 ─────────────────────────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          method: 'POST',
          headers,
          body: JSON.stringify({ docId: 'x' }),
        })
        expect(r.status).toBe(401)
      }

      // ── 13. Token without files:read → 403 ───────────────────────────────
      {
        const r = await h.req('/api/v1/embed/nonce', {
          token: noFilesRead,
          method: 'POST',
          headers,
          body: JSON.stringify({ docId: 'x' }),
        })
        expect(r.status).toBe(403)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
