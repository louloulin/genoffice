/**
 * End-to-end coverage for the per-tenant rate limiter (A17 / A59 / A60 /
 * A61): the over-limit HTTP contract (429 + `Retry-After`) and full tenant
 * isolation, driven against the live bundle.
 *
 * The harness boots with tiny buckets (`capacity: 2`, `refillPerSec: 0`) so a
 * tenant drains deterministically. The bucket arithmetic itself is unit-tested
 * in `rate-limit.test.ts`; this suite proves the limiter is actually mounted on
 * the `/api/v1/*` surface and on the legacy `/api/ai/stream` route.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const bundle = join(import.meta.dirname, '..', 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('per-tenant rate limiting (live)', () => {
  let h: ServerHarness

  beforeAll(async () => {
    h = await ServerHarness.start({
      env: {
        GENOFFICE_RATE_LIMIT_CAPACITY: '2',
        GENOFFICE_RATE_LIMIT_REFILL_PER_SEC: '0',
      },
    })
  }, 30_000)

  afterAll(async () => {
    await h?.stop()
  })

  it('answers 429 with a Retry-After header once a tenant drains its bucket', async () => {
    const acme = await h.token('acme-user', ['files:read'], { tenant: 'acme' })
    const r1 = await h.req('/api/v1/health', { token: acme })
    const r2 = await h.req('/api/v1/health', { token: acme })
    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    const r3 = await h.req<{ error: { code: string; retryAfter: number; limit: number } }>(
      '/api/v1/health',
      { token: acme },
    )
    expect(r3.status).toBe(429)
    expect(r3.body.error.code).toBe('RATE_LIMITED')
    expect(r3.body.error.limit).toBe(2)
    const retryAfter = r3.headers.get('retry-after')
    expect(retryAfter).toBeTruthy()
    expect(Number(retryAfter)).toBeGreaterThan(0)
  })

  it('keeps tenant buckets isolated', async () => {
    const acme = await h.token('acme-user', ['files:read'], { tenant: 'acme' })
    const globex = await h.token('globex-user', ['files:read'], { tenant: 'globex' })
    // Drain acme's bucket for this endpoint.
    await h.req('/api/v1/health', { token: acme })
    await h.req('/api/v1/health', { token: acme })
    expect((await h.req('/api/v1/health', { token: acme })).status).toBe(429)
    // A different tenant is untouched and still gets its full bucket.
    const first = await h.req('/api/v1/health', { token: globex })
    expect(first.status).toBe(200)
  })

  it('limits the legacy /api/ai/stream route too', async () => {
    const acme = await h.token('acme-user', ['ai:chat'], { tenant: 'acme' })
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })
    const post = () =>
      h.req('/api/ai/stream', {
        method: 'POST',
        token: acme,
        headers: { 'content-type': 'application/json' },
        body,
      })
    // First two requests pass the limiter (they may error on the unconfigured
    // provider — irrelevant here); the third is rejected before the handler runs.
    await post()
    await post()
    const third = await post()
    expect(third.status).toBe(429)
    expect(third.headers.get('retry-after')).toBeTruthy()
  }, 20_000)
})
