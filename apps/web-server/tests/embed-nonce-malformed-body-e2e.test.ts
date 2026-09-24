/**
 * Embed-nonce endpoints malformed-body validation (sdk1 §11.119).
 *
 * Pins the boundary that the 3 embed-nonce handlers reject malformed
 * JSON bodies with 400 INVALID_ARGUMENT (matching the v1 REST envelope
 * convention) instead of leaking the raw `SyntaxError` message as a
 * 500. Whitespace-only bodies are treated as "no body" — same convention
 * as §11.115/§11.116 null/undefined semantics.
 *
 * Three endpoints covered:
 *   - POST   /api/v1/embed/nonce           (handleEmbedNonce)
 *   - POST   /api/v1/embed/verify-nonce    (handleEmbedVerifyNonce)
 *   - DELETE /api/v1/embed/nonce           (handleEmbedReleaseNonce)
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

// Bodies that produce a JSON.parse SyntaxError → 400 INVALID_ARGUMENT (the §11.119 fix).
const TRULY_MALFORMED: ReadonlyArray<readonly [string, string]> = [
  ['plain garbage', 'not json'],
  ['truncated JSON', '{"sessionId":"x"'],
  ['trailing comma', '{"sessionId":"x",}'],
  ['unclosed brace', '{sessionId:"x"'],
]

// Bodies that JSON.parse accepts but yield a non-object (string / number /
// boolean / null) → handler skips the parse error path and the existing
// field-validation 400 BAD_REQUEST fires (since `body.docId` etc. is
// undefined). This is correct downstream behavior — no 500 leak, no
// contract drift — and we pin it here so a future refactor doesn't
// accidentally swap the field-validation code to INVALID_ARGUMENT or vice
// versa.
const VALID_JSON_WRONG_TYPE: ReadonlyArray<readonly [string, string]> = [
  ['string literal', '"just a string"'],
  ['number literal', '42'],
  ['true literal', 'true'],
  ['null literal', 'null'],
]

describe.skipIf(skip)('embed-nonce malformed body validation (sdk1 §11.119)', () => {
  it('returns 400 INVALID_ARGUMENT (not 500 SyntaxError leak) for malformed JSON across all 3 endpoints', async () => {
    const h = await ServerHarness.start()
    const token = await h.token('embed-malformed-tester', ['files:read', 'admin'])
    const headers = { 'content-type': 'application/json' }

    // All three endpoints are reachable from the v1 bearer-token
    // harness; the embed-session context isn't required to exercise
    // the body-validation gate.
    const endpoints = [
      { method: 'POST' as const, path: '/api/v1/embed/nonce', channel: 'embed:nonce' },
      { method: 'POST' as const, path: '/api/v1/embed/verify-nonce', channel: 'embed:verify-nonce' },
      { method: 'DELETE' as const, path: '/api/v1/embed/nonce', channel: 'embed:release-nonce' },
    ]

    try {
      // ── Phase 1: each endpoint rejects truly-malformed bodies with 400 INVALID_ARGUMENT ──
      for (const ep of endpoints) {
        for (const [label, body] of TRULY_MALFORMED) {
          const r = await h.req<{ error?: { code: string; message: string; channel: string } }>(
            ep.path,
            {
              method: ep.method,
              token,
              headers,
              body,
            },
          )
          expect(
            r.status,
            `${ep.method} ${ep.path} malformed ${label}: ${JSON.stringify(body)}`,
          ).toBe(400)
          // Must use the v1 REST error envelope: { error: { code, message, channel } }
          // (sdk1 §2.1.A). The OLD bug returned 500 with raw SyntaxError text.
          const errorObj = (r.body as { error?: { code: string; message: string; channel: string } })
            .error
          expect(errorObj, `${ep.method} ${ep.path} malformed ${label} has error envelope`).toBeDefined()
          expect(errorObj!.code, `${ep.method} ${ep.path} malformed ${label} code`).toBe('INVALID_ARGUMENT')
          expect(errorObj!.channel, `${ep.method} ${ep.path} malformed ${label} channel`).toBe(ep.channel)
          expect(errorObj!.message, `${ep.method} ${ep.path} malformed ${label} message`).toMatch(/invalid JSON body/i)
        }
      }

      // ── Phase 1b: each endpoint also handles valid-JSON-but-wrong-type with 400 BAD_REQUEST ──
      // JSON.parse accepts these (string / number / bool / null literals are valid
      // JSON), but the handler then sees a non-object body → existing
      // field-validation 400 BAD_REQUEST fires. We pin this so:
      //   1. The error is NOT a 500 leak (the original bug class)
      //   2. The code stays BAD_REQUEST (consistent with field-validation)
      for (const ep of endpoints) {
        for (const [label, body] of VALID_JSON_WRONG_TYPE) {
          const r = await h.req<{ error?: { code: string; message: string; channel: string } }>(
            ep.path,
            {
              method: ep.method,
              token,
              headers,
              body,
            },
          )
          expect(
            r.status,
            `${ep.method} ${ep.path} wrong-type ${label}: ${JSON.stringify(body)}`,
          ).toBe(400)
          const errorObj = (r.body as { error?: { code: string; message: string; channel: string } })
            .error
          expect(errorObj, `${ep.method} ${ep.path} wrong-type ${label} has error envelope`).toBeDefined()
          expect(errorObj!.code, `${ep.method} ${ep.path} wrong-type ${label} code`).toBe('BAD_REQUEST')
          expect(errorObj!.channel, `${ep.method} ${ep.path} wrong-type ${label} channel`).toBe(ep.channel)
        }
      }

      // ── Phase 2: whitespace-only body treated as "no body" → 400 from field validation ──
      // Each endpoint has its own field-validation 400 — we just verify
      // it's NOT a 500 (the old buggy path) and that the response is
      // a normal validation rejection (not a JSON parse leak).
      for (const ep of endpoints) {
        const r = await h.req<{ error?: { code: string; message: string } }>(
          ep.path,
          {
            method: ep.method,
            token,
            headers,
            body: '   ',
          },
        )
        // Whitespace-only → treated as `{}` → field validation 400 (NOT a
        // SyntaxError 500 leak). The exact message varies by endpoint
        // (docId / sessionId+nonce / sessionId), but the shape is consistent.
        expect(r.status, `${ep.method} ${ep.path} whitespace-only body`).toBe(400)
        expect(
          (r.body as { error?: { code: string } }).error?.code,
          `${ep.method} ${ep.path} whitespace-only body code`,
        ).toBe('BAD_REQUEST') // existing field-validation uses BAD_REQUEST (not INVALID_ARGUMENT) — pin current convention
      }

      // ── Phase 3: empty body → same field-validation 400 ────────────────
      for (const ep of endpoints) {
        const r = await h.req<{ error?: { code: string } }>(ep.path, {
          method: ep.method,
          token,
          headers,
        })
        expect(r.status, `${ep.method} ${ep.path} empty body`).toBe(400)
        expect(
          (r.body as { error?: { code: string } }).error?.code,
          `${ep.method} ${ep.path} empty body code`,
        ).toBe('BAD_REQUEST')
      }

      // ── Phase 4: valid body still works (regression baseline) ───────────
      {
        // POST /embed/nonce with valid docId
        const r = await h.req<{ sessionId: string; nonce: string; expiresAt: number }>(
          '/api/v1/embed/nonce',
          {
            method: 'POST',
            token,
            headers,
            body: JSON.stringify({ docId: 'valid-doc-id' }),
          },
        )
        expect(r.status).toBe(200)
        expect(r.body.sessionId).toBeTruthy()
        expect(r.body.nonce).toBeTruthy()
      }

      // ── Phase 5: server still healthy after the bad-input storm ────────
      const health = await h.req<{ status: string }>('/health')
      expect(health.status).toBe(200)
    } finally {
      await h.stop()
    }
  }, 60_000)
})
