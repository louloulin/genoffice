/**
 * End-to-end lifecycle for the v1 AI translate + image surface
 * (sdk1.md §11.103).
 *
 * Pins the boundary added by the §11.103 fix:
 *
 *   - POST /api/v1/ai/translate  must accept the documented REST shape
 *     `{ text, from?, to }` (not the IPC `{ instruction, targetLang, ... }`),
 *     so hosts see the documented surface and only see IPC-level errors
 *     when they are genuinely invalid. Previously the handler forwarded
 *     the body object straight through to the IPC, the IPC rejected it
 *     with `expected non-empty 'instruction'`, and the REST returned that
 *     error verbatim — confusing because the REST docs only mention
 *     `text`/`from`/`to`.
 *
 *   - POST /api/v1/ai/image      must validate `url` is a non-empty string
 *     <= 4096 chars before forwarding to `ai:fetch-image`. The IPC actually
 *     fetches an image FROM a URL (it is not an image-generation endpoint),
 *     and previously the handler forwarded raw body — the IPC returned
 *     `null` for non-string URLs and the REST returned `{ "null" }`
 *     looking like success. Now an invalid request gets a clear 400 with
 *     a code that hosts can branch on.
 *
 * Covers happy + auth / scope / input-validation branches.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 AI translate + image shape validation', () => {
  it('walks translate + image + auth / scope / input-validation branches', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('ai-tester', [
      'ai:read',
      'ai:translate',
      'ai:image',
      'admin',
    ])
    const noAi = await h.token('no-ai', ['files:read'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token, method: 'POST' as const, headers }

    try {
      // 1. translate with documented REST shape {text, from, to}
      // The IPC will be called with { instruction, sourceLang, targetLang }.
      // The upstream provider may fail (Claude 403 / network issue), but
      // the contract here is: NOT `expected non-empty 'instruction'` —
      // that means the IPC received a valid shape.
      {
        const r = await h.req<{ ok?: boolean; result?: string; error?: string }>(
          '/api/v1/ai/translate',
          {
            ...authPost,
            body: JSON.stringify({ text: 'Hello world', from: 'en', to: 'zh' }),
          },
        )
        expect(r.status).toBe(200)
        const errMsg = typeof r.body.error === 'string' ? r.body.error : ''
        expect(errMsg.startsWith('expected non-empty')).toBe(false)
      }

      // 2. translate without `from` (optional) still works
      {
        const r = await h.req<{ error?: string }>('/api/v1/ai/translate', {
          ...authPost,
          body: JSON.stringify({ text: 'Hello', to: 'zh' }),
        })
        expect(r.status).toBe(200)
        const errMsg = typeof r.body.error === 'string' ? r.body.error : ''
        expect(errMsg.startsWith('expected non-empty')).toBe(false)
      }

      // 3. translate also accepts IPC-shape { instruction, targetLang }
      // so existing IPC-style callers do not break.
      {
        const r = await h.req<{ error?: string }>('/api/v1/ai/translate', {
          ...authPost,
          body: JSON.stringify({ instruction: 'Hello', targetLang: 'zh' }),
        })
        expect(r.status).toBe(200)
        const errMsg = typeof r.body.error === 'string' ? r.body.error : ''
        expect(errMsg.startsWith('expected non-empty')).toBe(false)
      }

      // NEGATIVE: translate missing `to` -> 400
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/translate',
          {
            ...authPost,
            body: JSON.stringify({ text: 'Hello' }),
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('to')
      }

      // NEGATIVE: translate missing `text` -> 400
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/translate',
          {
            ...authPost,
            body: JSON.stringify({ to: 'zh' }),
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('text')
      }

      // NEGATIVE: translate empty body -> 400
      {
        const r = await h.req<{ error: { code: string } }>('/api/v1/ai/translate', {
          ...authPost,
          body: JSON.stringify({}),
        })
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // NEGATIVE: translate invalid JSON -> 400
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/translate',
          {
            ...authPost,
            body: 'not-json',
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toBe('invalid JSON body')
      }

      // NEGATIVE: translate no JWT -> 401
      {
        const r = await h.req('/api/v1/ai/translate', {
          method: 'POST',
          headers,
          body: JSON.stringify({ text: 'x', to: 'zh' }),
        })
        expect(r.status).toBe(401)
      }

      // NEGATIVE: translate token without ai:translate -> 403
      {
        const r = await h.req('/api/v1/ai/translate', {
          method: 'POST',
          headers,
          token: noAi,
          body: JSON.stringify({ text: 'x', to: 'zh' }),
        })
        expect(r.status).toBe(403)
      }

      // 9. ai:image with valid url -> IPC fetches
      // The contract is "IPC was called with a URL string, not the raw body".
      // Either base64 (fetch worked) or null (fetch failed) is valid.
      {
        const r = await h.req<{ base64?: string; mime?: string; ok?: boolean; error?: string }>(
          '/api/v1/ai/image',
          {
            ...authPost,
            body: JSON.stringify({
              url: 'https://httpbin.org/image/png',
            }),
          },
        )
        expect(r.status).toBe(200)
        const errMsg = typeof r.body.error === 'string' ? r.body.error : ''
        expect(errMsg.startsWith('expected')).toBe(false)
      }

      // NEGATIVE: ai:image with `prompt` only (no url) -> 400
      // This was the silent-null bug: prompt-only used to forward as
      // { prompt: "..." } to the IPC, IPC rejected as not-a-string, and
      // REST returned { "null" }. Now the URL validator catches it
      // before the IPC and returns a clean 400.
      {
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/image',
          {
            ...authPost,
            body: JSON.stringify({ prompt: 'a cat' }),
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('url')
      }

      // NEGATIVE: ai:image empty body -> 400
      {
        const r = await h.req<{ error: { code: string } }>('/api/v1/ai/image', {
          ...authPost,
          body: JSON.stringify({}),
        })
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
      }

      // NEGATIVE: ai:image with url > 4096 chars -> 400
      {
        const longUrl = 'https://example.com/' + 'a'.repeat(4096)
        const r = await h.req<{ error: { code: string; message: string } }>(
          '/api/v1/ai/image',
          {
            ...authPost,
            body: JSON.stringify({ url: longUrl }),
          },
        )
        expect(r.status).toBe(400)
        expect(r.body.error.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error.message).toContain('4096')
      }

      // NEGATIVE: ai:image no JWT -> 401
      {
        const r = await h.req('/api/v1/ai/image', {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: 'https://example.com/x.png' }),
        })
        expect(r.status).toBe(401)
      }

      // NEGATIVE: ai:image token without ai:image -> 403
      {
        const r = await h.req('/api/v1/ai/image', {
          method: 'POST',
          headers,
          token: noAi,
          body: JSON.stringify({ url: 'https://example.com/x.png' }),
        })
        expect(r.status).toBe(403)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
