/**
 * Comprehensive v1 REST API smoke test (sdk1 follow-up).
 *
 * Boots the real bundle via `ServerHarness` and exercises every public
 * v1 endpoint in one place. The intent is a single canonical "does the
 * advertised surface work" check that anyone can re-run during
 * refactors to catch regressions before they ship.
 *
 * Pinning:
 *   - status code for each route
 *   - content-type (JSON for v1, not the SPA HTML fallback)
 *   - shape of the JSON envelope (key fields present)
 *
 * The test is intentionally shallow — it does NOT exercise auth scope
 * permutations, error envelopes for every invalid input, or
 * end-to-end business flows (those live in dedicated suites like
 * `api-v1-e2e`, `comments-v1-endpoint`, `versions-v1-endpoint`,
 * `webhook-delete-purges-dlq`). This suite is the "does the route
 * exist at all" gate.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, SmokeRecorder } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 REST API smoke (sdk1 follow-up)', () => {
  it('every public v1 route returns 200 + sane payload', async () => {
    const h = await ServerHarness.start()
    const rec = new SmokeRecorder()
    try {
      // Admin scope covers every auth-gated endpoint we want to touch.
      const token = await h.token('smoke-tester', [
        'files:write',
        'files:read',
        'ai:read',
        'ai:chat',
        'ai:translate',
        'ai:image',
        'ai:skill',
        'webhooks:manage',
        'kb:read',
        'admin',
      ])
      const authGet = { token }
      const jsonAuth = { token, headers: { 'content-type': 'application/json' } }

      // ---- public (no auth) ----
      {
        const r = await h.req<{ status: string; implementedChannels: number }>('/api/v1/health')
        rec.record('GET /api/v1/health', r.status === 200 && r.body.status === 'ok', `channels=${r.body.implementedChannels}`)
      }
      {
        const r = await h.req('/api/v1/changelog')
        rec.record('GET /api/v1/changelog', r.status === 200 && typeof r.text === 'string', `bytes=${r.text.length}`)
      }
      {
        const r = await h.req<{ serverVersion: string; sdkVersion: string }>('/api/v1/meta')
        rec.record('GET /api/v1/meta', r.status === 200 && r.body.serverVersion !== undefined, `server=${r.body.serverVersion}`)
      }
      {
        const r = await h.req('/api/v1/metrics')
        rec.record('GET /api/v1/metrics', r.status === 200, `bytes=${r.text.length}`)
      }

      // ---- auth-gated (token) ----
      {
        const r = await h.req<{ files: unknown[] }>('/api/v1/files', authGet)
        rec.record('GET /api/v1/files', r.status === 200 && Array.isArray(r.body.files), `count=${r.body.files?.length}`)
      }
      {
        const r = await h.req<{ capabilities: object }>('/api/v1/ai/capabilities', authGet)
        rec.record('GET /api/v1/ai/capabilities', r.status === 200 && r.body.capabilities !== undefined, `keys=${Object.keys(r.body.capabilities ?? {}).length}`)
      }
      {
        const r = await h.req<{ entries: unknown[] }>('/api/v1/kb/entries', authGet)
        rec.record('GET /api/v1/kb/entries', r.status === 200 && Array.isArray(r.body.entries), `count=${r.body.entries?.length}`)
      }
      {
        const r = await h.req('/api/v1/kb/search?q=test', authGet)
        rec.record('GET /api/v1/kb/search?q=test', r.status === 200, `status=${r.status}`)
      }
      {
        const r = await h.req<{ count: number }>('/api/v1/webhooks/dlq', authGet)
        rec.record('GET /api/v1/webhooks/dlq', r.status === 200 && typeof r.body.count === 'number', `count=${r.body.count}`)
      }

      // ---- webhook subscription lifecycle ----
      {
        const r = await h.req('/api/v1/webhooks', {
          ...jsonAuth, method: 'POST', body: JSON.stringify({ url: 'http://127.0.0.1:1/dead', events: ['file.saved'] }),
        })
        rec.record('POST /api/v1/webhooks (upsert)', r.status === 201, `status=${r.status}`)
      }
      {
        const r = await h.req('/api/v1/webhooks', { ...authGet, method: 'DELETE' })
        rec.record('DELETE /api/v1/webhooks (purge DLQ)', r.status === 200 && (r.body as { dlqPurged?: unknown }).dlqPurged !== undefined, `dlqPurged=${JSON.stringify((r.body as { dlqPurged?: unknown }).dlqPurged)}`)
      }
      {
        const r = await h.req('/api/v1/webhooks', { ...authGet, method: 'DELETE' })
        rec.record('DELETE /api/v1/webhooks idempotent', r.status === 200 && (r.body as { removed: boolean }).removed === false, `removed=${(r.body as { removed: boolean }).removed}`)
      }

      // ---- AI endpoints (LLM may be unconfigured → 4xx/5xx accepted) ----
      {
        const r = await h.req('/api/v1/ai/chat', {
          ...jsonAuth, method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        })
        rec.record('POST /api/v1/ai/chat', r.status === 200 || r.status === 400 || r.status === 503, `status=${r.status}`)
      }
      {
        const r = await h.req('/api/v1/ai/translate', {
          ...jsonAuth, method: 'POST', body: JSON.stringify({ text: 'hi', from: 'en', to: 'zh' }),
        })
        rec.record('POST /api/v1/ai/translate', r.status === 200 || r.status === 400 || r.status === 503, `status=${r.status}`)
      }
      {
        const r = await h.req('/api/v1/ai/skill/text-summarize', {
          ...jsonAuth, method: 'POST', body: JSON.stringify({ input: { text: 'hello world' } }),
        })
        rec.record('POST /api/v1/ai/skill/text-summarize', r.status === 200 || r.status === 400 || r.status === 503, `status=${r.status}`)
      }

      // ---- embed nonce lifecycle ----
      {
        const r = await h.req<{ sessionId: string; nonce: string }>('/api/v1/embed/nonce', {
          ...jsonAuth, method: 'POST', body: JSON.stringify({ docId: 'smoke-doc-1', app: 'docs' }),
        })
        rec.record('POST /api/v1/embed/nonce', r.status === 200 && !!r.body.sessionId, `sessionId=${(r.body.sessionId ?? '').slice(0, 10)}`)
        if (r.body.sessionId) {
          const sid = r.body.sessionId
          const nonce = r.body.nonce
          {
            const r2 = await h.req<{ valid: boolean }>('/api/v1/embed/verify-nonce', {
              ...jsonAuth, method: 'POST', body: JSON.stringify({ sessionId: sid, nonce }),
            })
            rec.record('POST /api/v1/embed/verify-nonce', r2.status === 200 && r2.body.valid === true, `valid=${r2.body.valid}`)
          }
          {
            const r3 = await h.req<{ released: boolean }>('/api/v1/embed/nonce', {
              ...jsonAuth, method: 'DELETE', body: JSON.stringify({ sessionId: sid }),
            })
            rec.record('DELETE /api/v1/embed/nonce', r3.status === 200 && r3.body.released === true, `released=${r3.body.released}`)
          }
        }
      }

      // ---- 404 envelope on truly-unknown /api/v1/* paths; 405 for wrong method on existing routes (sdk1 §11.111) ----
      {
        // sdk1 §11.111: /api/v1/webhooks is a known v1 path; only POST / DELETE
        // are valid. The previous test asserted 404 (which was the bug —
        // RFC 7231 violation: wrong-method on an existing path must be 405,
        // not 404). 404 is reserved for paths that don't exist at any method.
        const r = await h.req<{ error: { code: string; allow: string } }>('/api/v1/webhooks', { method: 'GET' })
        rec.record(
          'GET /api/v1/webhooks → 405 METHOD_NOT_ALLOWED with allow list (sdk1 §11.111)',
          r.status === 405 &&
            r.headers.get('content-type')?.includes('application/json') &&
            r.body.error.code === 'METHOD_NOT_ALLOWED' &&
            r.body.error.allow === 'POST, DELETE',
          `status=${r.status}`,
        )
      }
      {
        const r = await h.req('/api/v1/totally-unknown')
        rec.record('GET /api/v1/totally-unknown → 404 JSON', r.status === 404 && r.headers.get('content-type')?.includes('application/json'), `status=${r.status}`)
      }

      rec.printSummary()
      expect(rec.summary().ok).toBe(true)
    } finally {
      await h.stop()
    }
  }, 60_000)
})
