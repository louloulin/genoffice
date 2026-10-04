/**
 * Unit coverage for the per-tenant token-bucket rate limiter (A17 / A59 /
 * A60 / A61). Exercises the bucket arithmetic, tenant isolation, per-tenant
 * and per-endpoint config resolution, and endpoint-key normalization without
 * booting the server. The over-limit *HTTP* contract (429 + Retry-After) is
 * covered end-to-end in `rate-limit-e2e.test.ts`.
 *
 * Isolation pattern: per-case TMP DATA_DIR + vi.resetModules so each case owns
 * its cached config and bucket map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'rate-limit-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_RATE_LIMIT_CAPACITY', '2')
  vi.stubEnv('GENOFFICE_RATE_LIMIT_REFILL_PER_SEC', '0')
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function load() {
  return await import('../src/common/rate-limit')
}

describe('checkRateLimit', () => {
  it('denies the request once the bucket is drained and reports Retry-After', async () => {
    const { checkRateLimit, _resetRateLimitForTests } = await load()
    _resetRateLimitForTests()
    const endpoint = '/api/v1/health'
    const now = 1_000_000
    expect(checkRateLimit('acme', endpoint, now).allowed).toBe(true)
    expect(checkRateLimit('acme', endpoint, now).allowed).toBe(true)
    const denied = checkRateLimit('acme', endpoint, now)
    expect(denied.allowed).toBe(false)
    expect(denied.limit).toBe(2)
    expect(denied.remaining).toBe(0)
    expect(denied.retryAfterSec).toBeGreaterThan(0)
    expect(Number.isInteger(denied.retryAfterSec)).toBe(true)
  })

  it('isolates tenant buckets — one tenant draining never affects another', async () => {
    const { checkRateLimit, _resetRateLimitForTests } = await load()
    _resetRateLimitForTests()
    const endpoint = '/api/v1/health'
    const now = 1_000_000
    checkRateLimit('acme', endpoint, now)
    checkRateLimit('acme', endpoint, now)
    expect(checkRateLimit('acme', endpoint, now).allowed).toBe(false)
    // A different tenant starts with a full bucket for the same endpoint.
    expect(checkRateLimit('globex', endpoint, now).allowed).toBe(true)
    // ...and the same tenant on a different endpoint also starts full.
    expect(checkRateLimit('acme', '/api/v1/meta', now).allowed).toBe(true)
  })

  it('refills at the configured sustained rate', async () => {
    const { checkRateLimit, setRateLimitConfig, _resetRateLimitForTests } = await load()
    _resetRateLimitForTests()
    setRateLimitConfig({ defaults: { capacity: 1, refillPerSec: 10 }, tenants: {} })
    const endpoint = '/api/ai/stream'
    expect(checkRateLimit('acme', endpoint, 0).allowed).toBe(true)
    // Immediately after: no token yet.
    expect(checkRateLimit('acme', endpoint, 0).allowed).toBe(false)
    // 200 ms later, 10 tokens/s * 0.2 s = 2 tokens → capped at 1 → allowed.
    expect(checkRateLimit('acme', endpoint, 200).allowed).toBe(true)
  })
})

describe('configuration resolution', () => {
  it('applies global defaults, then tenant defaults, then endpoint override', async () => {
    const { resolveRateLimitRule, setRateLimitConfig, _resetRateLimitForTests } = await load()
    _resetRateLimitForTests()
    setRateLimitConfig({
      defaults: { capacity: 100, refillPerSec: 20 },
      tenants: {
        acme: {
          defaults: { capacity: 50 },
          endpoints: { '/api/v1/ai/chat': { capacity: 5, refillPerSec: 1 } },
        },
      },
    })
    // Global fallback for an unconfigured tenant.
    expect(resolveRateLimitRule('nobody', '/api/v1/ai/chat')).toEqual({
      capacity: 100,
      refillPerSec: 20,
    })
    // Tenant default merges over global (refillPerSec inherited).
    expect(resolveRateLimitRule('acme', '/api/v1/files')).toEqual({
      capacity: 50,
      refillPerSec: 20,
    })
    // Endpoint override merges over the tenant default.
    expect(resolveRateLimitRule('acme', '/api/v1/ai/chat')).toEqual({
      capacity: 5,
      refillPerSec: 1,
    })
  })

  it('reads per-tenant limits from the persisted server-side file', async () => {
    const { join: joinPath } = await import('node:path')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      joinPath(TMP, 'rate-limit.json'),
      JSON.stringify({
        defaults: { capacity: 7, refillPerSec: 3 },
        tenants: { acme: { defaults: { capacity: 1, refillPerSec: 0 } } },
      }),
      'utf8',
    )
    const { resolveRateLimitRule, reloadRateLimitConfig } = await load()
    reloadRateLimitConfig()
    expect(resolveRateLimitRule('acme', '/api/v1/health')).toEqual({
      capacity: 1,
      refillPerSec: 0,
    })
    expect(resolveRateLimitRule('globex', '/api/v1/health')).toEqual({
      capacity: 7,
      refillPerSec: 3,
    })
  })

  it('normalizes high-cardinality path segments into one bucket key', async () => {
    const { normalizeEndpointPath } = await load()
    expect(normalizeEndpointPath('/api/v1/files/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(
      '/api/v1/files/:id',
    )
    expect(normalizeEndpointPath('/api/v1/files/12345')).toBe('/api/v1/files/:id')
    expect(normalizeEndpointPath('/api/v1/ai/chat')).toBe('/api/v1/ai/chat')
    expect(normalizeEndpointPath('/api/ai/stream')).toBe('/api/ai/stream')
  })

  it('caps the live bucket map so a hostile path space cannot grow memory', async () => {
    const { setRateLimitConfig, checkRateLimit, rateLimitBucketCount, _resetRateLimitForTests } =
      await load()
    _resetRateLimitForTests()
    setRateLimitConfig({ defaults: { capacity: 1, refillPerSec: 0 }, tenants: {} })
    for (let i = 0; i < 12_000; i++) {
      checkRateLimit('acme', `/api/v1/thing/${i}`, 0)
    }
    expect(rateLimitBucketCount()).toBeLessThanOrEqual(10_000)
  })
})
