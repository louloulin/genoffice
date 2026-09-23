/**
 * End-to-end lifecycle for the v1 AI chat + skill REST shape adapter
 * (sdk1.md §11.104).
 *
 * Pins the boundary added by the §11.104 fix:
 *
 *   - POST /api/v1/ai/chat must accept the documented REST shape
 *     `{ messages: [{ role, content }] }` (OpenAI-style, host-friendly).
 *     The IPC `ai:chat` requires `{ settings, system, user }`. Previously
 *     the handler forwarded the body object straight through, so every
 *     call returned `{ ok:false, error:"expected { settings, system, user }" }`.
 *
 *   - POST /api/v1/ai/skill/:name has the same bug class. The handler
 *     was forwarding raw body to IPC and only adding `skill: name` to
 *     the spread. Now it routes through the same REST -> IPC adapter.
 *
 *   - Both endpoints also accept the raw IPC shape `{ user, system, settings }`
 *     so renderer-internal callers keep working without rewriting.
 *
 *   - Both endpoints return 400 INVALID_ARGUMENT on missing/empty user
 *     message instead of the silent IPC reject.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 AI chat + skill shape validation', () => {
  it('walks chat + skill + auth / scope / input-validation branches', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('ai-chat-tester', [
      'ai:read',
      'ai:chat',
      'ai:skill',
      'admin',
    ])
    const noAi = await h.token('no-ai', ['files:read'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }

    // Helper: assert the IPC shape-rejection message does NOT leak.
    // The §11.104 bug returned exactly this error string verbatim.
    function expectNoIpcShapeReject(body: { error?: string; ok?: boolean }) {
      const errMsg = typeof body.error === 'string' ? body.error : ''
      expect(errMsg).not.toContain("expected { settings, system, user }")
      expect(errMsg).not.toContain('expected non-empty')
    }

    try {
      // 1. chat OpenAI-shape single user message
      {
        const r = await h.req<{ ok?: boolean; result?: string; error?: string }>(
          '/api/v1/ai/chat',
          {
            ...authPost,
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'say hi' }],
            }),
          },
        )
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // 2. chat OpenAI-shape system + user
      {
        const r = await h.req<{ error?: string }>('/api/v1/ai/chat', {
          ...authPost,
          body: JSON.stringify({
            messages: [
              { role: 'system', content: 'You are concise.' },
              { role: 'user', content: 'greet me' },
            ],
          }),
        })
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // 3. chat IPC-shape compat (renderer-internal callers)
      {
        const r = await h.req<{ error?: string }>('/api/v1/ai/chat', {
          ...authPost,
          body: JSON.stringify({ user: 'say hi', system: 'concise' }),
        })
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // NEGATIVE: chat empty messages -> 400
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/chat',
          { ...authPost, body: JSON.stringify({ messages: [] }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('messages')
      }

      // NEGATIVE: chat no user message -> 400
      {
        const r = await h.req<{ error: { code: string } }>('/api/v1/ai/chat', {
          ...authPost,
          body: JSON.stringify({
            messages: [{ role: 'system', content: 'only system here' }],
          }),
        })
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // NEGATIVE: chat invalid JSON -> 400
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/chat',
          { ...authPost, body: 'not-json' },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toBe('invalid JSON body')
      }

      // NEGATIVE: chat no JWT -> 401
      {
        const r = await h.req('/api/v1/ai/chat', {
          method: 'POST',
          headers,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
        })
        expect(r.status).toBe(401)
      }

      // NEGATIVE: chat token without ai:chat -> 403
      {
        const r = await h.req('/api/v1/ai/chat', {
          method: 'POST',
          headers,
          token: noAi,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
        })
        expect(r.status).toBe(403)
      }

      // 9. skill OpenAI-shape (was silently IPC-rejected before)
      {
        const r = await h.req<{ error?: string }>(
          '/api/v1/ai/skill/translate-text',
          {
            ...authPost,
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'hi' }],
            }),
          },
        )
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // 10. skill IPC-shape compat
      {
        const r = await h.req<{ error?: string }>(
          '/api/v1/ai/skill/translate-text',
          {
            ...authPost,
            body: JSON.stringify({ user: 'hi', system: 'concise' }),
          },
        )
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // 11. skill with unknown name still gets dispatched
      // (the skill dispatcher decides 404 vs invocation; what we pin is
      // the REST->IPC shape adapter, not skill existence)
      {
        const r = await h.req<{ error?: string }>(
          '/api/v1/ai/skill/no-such-skill',
          {
            ...authPost,
            body: JSON.stringify({
              messages: [{ role: 'user', content: 'hi' }],
            }),
          },
        )
        expect(r.status).toBe(200)
        expectNoIpcShapeReject(r.body)
      }

      // NEGATIVE: skill empty messages -> 400
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/v1/ai/skill/translate-text',
          { ...authPost, body: JSON.stringify({ messages: [] }) },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // NEGATIVE: skill no user message -> 400
      {
        const r = await h.req<{ error: { code: string } }>(
          '/api/v1/ai/skill/translate-text',
          {
            ...authPost,
            body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }),
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // NEGATIVE: skill no JWT -> 401
      {
        const r = await h.req('/api/v1/ai/skill/translate-text', {
          method: 'POST',
          headers,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
        })
        expect(r.status).toBe(401)
      }

      // NEGATIVE: skill token without ai:skill -> 403
      {
        const r = await h.req('/api/v1/ai/skill/translate-text', {
          method: 'POST',
          headers,
          token: noAi,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
        })
        expect(r.status).toBe(403)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
