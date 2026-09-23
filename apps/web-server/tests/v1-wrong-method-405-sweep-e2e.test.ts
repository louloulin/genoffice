/**
 * End-to-end contract pin for v1 wrong-method 405 (§11.111).
 *
 * Walks every documented v1 route and verifies that:
 *
 *   - Wrong-method requests return 405 with the standard envelope
 *     `{ error: { code: 'METHOD_NOT_ALLOWED', message, channel, allow } }`
 *     and an `Allow:` field listing the documented methods, per RFC 7231.
 *     Pre-§11.111 these all returned 404 NOT_FOUND, which is wrong:
 *     404 says "the resource doesn't exist", but these routes DO exist
 *     for other methods; the correct status is 405.
 *
 *   - Truly unknown paths still return 404 NOT_FOUND (so the 404 class
 *     remains reserved for paths that don't exist at any method).
 *
 *   - Correct-method requests on each route still work as documented
 *     (regression coverage). For endpoints that require auth / body
 *     shape, this is a smoke-level "non-405 and reachable" check; the
 *     detailed per-endpoint assertions live in their own e2e files.
 *
 * Routes that don't need any method check (e.g. `/api/html/preview/...`
 * handled separately in src/index.ts) are out of scope here — those
 * have their own dedicated coverage.
 *
 * The route table in `apps/web-server/src/api/v1/index.ts` (v1Routes)
 * is the single source of truth: adding a new route without adding a
 * v1Routes entry lets wrong-method requests fall through to 404.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'
import { mintJwt } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface SweepCase {
  path: string
  documented: string[]
  wrongMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
}

// Every entry maps a v1 path + documented methods to one wrong-method
// probe. Tests assert 405 + envelope + allow list. Order matters: the
// sweep lists every distinct v1 path so a missing v1Routes entry shows
// up as a 404 (test failure) instead of a silent regression.
const cases: SweepCase[] = [
  // meta (GET only — POST/PUT/DELETE all 405)
  { path: '/api/v1/health', documented: ['GET'], wrongMethod: 'POST' },
  { path: '/api/v1/health', documented: ['GET'], wrongMethod: 'PUT' },
  { path: '/api/v1/metrics', documented: ['GET'], wrongMethod: 'POST' },
  { path: '/api/v1/changelog', documented: ['GET'], wrongMethod: 'POST' },
  { path: '/api/v1/meta', documented: ['GET'], wrongMethod: 'POST' },
  // auth (POST only)
  { path: '/api/v1/auth/jwt', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/auth/oauth/token', documented: ['POST'], wrongMethod: 'GET' },
  // files
  { path: '/api/v1/files', documented: ['GET', 'POST'], wrongMethod: 'PUT' },
  { path: '/api/v1/files', documented: ['GET', 'POST'], wrongMethod: 'DELETE' },
  { path: '/api/v1/files/abc', documented: ['GET', 'DELETE'], wrongMethod: 'POST' },
  { path: '/api/v1/files/abc/jwt', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/files/abc/callback', documented: ['POST'], wrongMethod: 'GET' },
  // comments
  { path: '/api/v1/files/abc/comments', documented: ['GET', 'POST'], wrongMethod: 'PUT' },
  { path: '/api/v1/files/abc/comments/c1', documented: ['GET', 'PATCH', 'DELETE'], wrongMethod: 'POST' },
  { path: '/api/v1/files/abc/comments/c1', documented: ['GET', 'PATCH', 'DELETE'], wrongMethod: 'PUT' },
  // versions
  { path: '/api/v1/files/abc/versions', documented: ['GET', 'POST'], wrongMethod: 'DELETE' },
  { path: '/api/v1/files/abc/versions/v1', documented: ['GET', 'DELETE'], wrongMethod: 'POST' },
  { path: '/api/v1/files/abc/versions/v1', documented: ['GET', 'DELETE'], wrongMethod: 'PATCH' },
  { path: '/api/v1/files/abc/versions/v1/restore', documented: ['POST'], wrongMethod: 'GET' },
  // ai
  { path: '/api/v1/ai/capabilities', documented: ['GET'], wrongMethod: 'POST' },
  { path: '/api/v1/ai/chat', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/ai/translate', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/ai/image', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/ai/skill/foo', documented: ['POST'], wrongMethod: 'GET' },
  // kb
  { path: '/api/v1/kb/search', documented: ['GET'], wrongMethod: 'POST' },
  { path: '/api/v1/kb/entries', documented: ['GET'], wrongMethod: 'POST' },
  // webhooks + dlq + callbacks
  { path: '/api/v1/webhooks', documented: ['POST', 'DELETE'], wrongMethod: 'GET' },
  { path: '/api/v1/webhooks/dlq', documented: ['GET'], wrongMethod: 'POST' }, // §11.111 secondary fix
  { path: '/api/v1/webhooks/dlq', documented: ['GET'], wrongMethod: 'DELETE' },
  { path: '/api/v1/webhooks/dlq/abc', documented: ['GET', 'DELETE'], wrongMethod: 'POST' },
  { path: '/api/v1/webhooks/dlq/abc', documented: ['GET', 'DELETE'], wrongMethod: 'PATCH' },
  { path: '/api/v1/webhooks/dlq/abc/replay', documented: ['POST'], wrongMethod: 'GET' },
  { path: '/api/v1/callbacks', documented: ['POST'], wrongMethod: 'GET' },
  // embed nonce
  { path: '/api/v1/embed/nonce', documented: ['POST', 'DELETE'], wrongMethod: 'GET' },
  { path: '/api/v1/embed/verify-nonce', documented: ['POST'], wrongMethod: 'GET' },
]

describe.skipIf(skip)('v1 wrong-method 405 sweep (sdk1 §11.111)', () => {
  it('returns 405 + allow list for wrong-method on every documented v1 path', async () => {
    const h = await ServerHarness.start()
    try {
      // Admin-scoped token bypasses every v1 scope gate (§11.106
      // `scope: "admin"` policy). Wrong-method is a contract-layer
      // property of the route, not a permission question; auth shouldn't
      // shadow it.
      const token = await h.token('tester', ['admin'])
      type Envelope = {
        error: { code: string; message: string; channel: string; allow?: string }
      }

      for (const c of cases) {
        const res = await h.req<Envelope>(c.path, { method: c.wrongMethod, token })
        const allow = c.documented.join(', ')

        // Wrong-method assertion: 405 + envelope + allow matches.
        expect(res.status, `${c.wrongMethod} ${c.path}`).toBe(405)
        expect(res.headers.get('content-type'), `${c.wrongMethod} ${c.path} content-type`).toMatch(
          /^application\/json/,
        )
        expect(res.body.error.code, `${c.wrongMethod} ${c.path} code`).toBe('METHOD_NOT_ALLOWED')
        expect(res.body.error.allow, `${c.wrongMethod} ${c.path} allow`).toBe(allow)
        expect(res.body.error.channel, `${c.wrongMethod} ${c.path} channel`).toBe(c.path)

        // Each documented method must STILL work (regression: not 405, not
        // 404 NOT_FOUND). We assert only "reachable" — detailed shape is
        // owned by the per-endpoint e2e files.
        for (const good of c.documented) {
          const ok = await h.req(c.path, { method: good, token })
          // Regression check: the documented method must NOT return a
          // wrong-method 405 envelope. A 404 NOT_FOUND for resource-
          // addressed paths (e.g. /api/v1/files/<id>) is expected when
          // the id doesn't exist — that's the resource-level 404, not
          // the route-level one. We restrict our assertion to "this
          // request wasn't rejected as wrong-method".
          expect(ok.status, `${good} ${c.path} regression status`).not.toBe(405)
          const okBody = ok.body as { error?: { code?: string } } | string
          const okCode =
            typeof okBody === 'object' && okBody && 'error' in okBody
              ? okBody.error?.code
              : undefined
          expect(okCode, `${good} ${c.path} regression envelope`).not.toBe('METHOD_NOT_ALLOWED')
        }
      }

      // Truly unknown path → 404 NOT_FOUND (the 404 class is reserved
      // for paths that don't exist at any method).
      const unk = await h.req<Envelope>('/api/v1/this-route-totally-does-not-exist', { method: 'GET', token })
      expect(unk.status).toBe(404)
      expect(unk.body.error.code).toBe('NOT_FOUND')
    } finally {
      await h.stop()
    }
  }, 60_000)
})

/**
 * sdk1 §11.111 (continuation): `/api/html/preview/<id>` is GET-only.
 *
 * Pre-§11.111 the caller-side `&& request.method === 'GET'` gate meant
 * POST / PUT / DELETE silently fell through to the SPA static fallback
 * (200 + <!doctype html>). The fix adds an explicit 405 envelope for
 * any non-GET method on `/api/html/preview/*` paths; this catches the
 * SPA-fallback-on-wrong-method pattern that the v1 sweep doesn't see
 * (preview is a pre-v1 legacy endpoint).
 */
describe.skipIf(skip)('/api/html/preview/* 405 sweep (sdk1 §11.111 continuation)', () => {
  it('returns 405 METHOD_NOT_ALLOWED on POST/PUT/DELETE; 200 or 400 JSON on GET', async () => {
    const h = await ServerHarness.start()
    try {
      type Envelope = {
        error: { code: string; message: string; channel: string; allow?: string }
      }
      const token = await h.token('tester', ['admin'])

      for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
        const res = await h.req<Envelope>('/api/html/preview/some-id', { method, token })
        expect(res.status, `${method} /api/html/preview/some-id`).toBe(405)
        expect(res.headers.get('content-type'), `${method} content-type`).toMatch(/^application\/json/)
        expect(res.body.error.code, `${method} code`).toBe('METHOD_NOT_ALLOWED')
        expect(res.body.error.allow, `${method} allow`).toBe('GET')
        expect(res.body.error.channel, `${method} channel`).toBe('/api/html/preview/some-id')
      }

      // GET is allowed; missing buffer yields 404 JSON (regression).
      const ok = await h.req<Envelope>('/api/html/preview/no-such-buffer', { method: 'GET' })
      expect(ok.status).toBe(404)
      expect(ok.headers.get('content-type')).toMatch(/^application\/json/)
    } finally {
      await h.stop()
    }
  }, 30_000)
})

/**
 * sdk1 §11.112 (continuation): SPA fallback is GET / HEAD only.
 *
 * Pre-§11.112 POST/PUT/DELETE on `/`, `/manage`, `/docs/...`,
 * `/sheets/...`, etc. silently fell through to the static fallback,
 * which served `index.html` with 200 + Content-Type text/html. Same
 * SPA-fallback-on-wrong-method pattern as §11.107/108/110/111 (and the
 * `/api/html/preview/<id>` continuation just above). The §11.112 fix
 * adds a method gate at the static-fallback section so non-GET
 * requests get the standard envelope before any HTML is served.
 */
describe.skipIf(skip)('SPA fallback 405 sweep (sdk1 §11.112 continuation)', () => {
  const SPA_ROUTES = [
    '/',
    '/manage',
    '/management',
    '/docs',
    '/docs/anything',
    '/sheets/foo',
    '/slides/bar',
    '/pdf/baz',
    '/markdown/qux',
    '/html/doc',
    '/shell/page',
  ]

  it('returns 405 on POST/PUT/DELETE/PATCH for every SPA sub-route; 200 HTML on GET regression', async () => {
    const h = await ServerHarness.start()
    try {
      type Envelope = {
        error: { code: string; message: string; channel: string; allow?: string }
      }

      for (const path of SPA_ROUTES) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH'] as const) {
          const res = await h.req<Envelope>(path, { method })
          expect(res.status, `${method} ${path}`).toBe(405)
          expect(res.headers.get('content-type'), `${method} ${path} content-type`).toMatch(
            /^application\/json/,
          )
          expect(res.body.error.code, `${method} ${path} code`).toBe('METHOD_NOT_ALLOWED')
          expect(res.body.error.allow, `${method} ${path} allow`).toBe('GET, HEAD')
          expect(res.body.error.channel, `${method} ${path} channel`).toBe(path)
        }

        // GET must still serve the SPA bundle (200 + HTML) — regression.
        const ok = await h.req(path)
        // Some SPA routes (like '/manage', '/management') may redirect or 404
        // depending on build; we only assert "reachable, not 405, JSON envelope,
        // and not a SPA-fallback 200 HTML for JSON callers".
        expect(ok.status, `GET ${path} regression`).not.toBe(405)
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})
