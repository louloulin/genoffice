/**
 * End-to-end coverage for the `GET /api/v1/ai/usage` route (A18 / A22 / A62 /
 * A63): proves the v1 dispatcher actually reaches the handler over HTTP, that
 * the `ai:read` scope gate is enforced, and that the query parameters are
 * accepted/validated. The per-tenant aggregation and time-window semantics are
 * unit-tested in `ai-usage-query.test.ts`; a fresh harness has made no AI calls,
 * so the aggregate here is legitimately empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const bundle = join(import.meta.dirname, '..', 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface UsageBody {
  from: number
  to: number
  tenants: { tenantId: string; calls: number; totalTokens: number }[]
  totals: { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }
}

describe.skipIf(skip)('GET /api/v1/ai/usage (live)', () => {
  let h: ServerHarness

  beforeAll(async () => {
    h = await ServerHarness.start()
  }, 30_000)

  afterAll(async () => {
    await h?.stop()
  })

  it('requires a session (401 without a token)', async () => {
    const r = await h.req('/api/v1/ai/usage')
    expect(r.status).toBe(401)
  })

  it('requires the ai:read scope (403 without it)', async () => {
    const token = await h.token('acme-user', ['files:read'], { tenant: 'acme' })
    const r = await h.req<{ error: { code: string } }>('/api/v1/ai/usage', { token })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('FORBIDDEN')
  })

  it('returns an empty tenant aggregate on a fresh server', async () => {
    const token = await h.token('acme-user', ['ai:read'], { tenant: 'acme' })
    const r = await h.req<UsageBody>('/api/v1/ai/usage', { token })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body.tenants)).toBe(true)
    expect(r.body.totals.calls).toBe(0)
  })

  it('honours a future time window (excludes everything)', async () => {
    const token = await h.token('acme-user', ['ai:read'], { tenant: 'acme' })
    const from = Date.now() + 86_400_000
    const to = Date.now() + 172_800_000
    const r = await h.req<UsageBody>(`/api/v1/ai/usage?from=${from}&to=${to}`, { token })
    expect(r.status).toBe(200)
    expect(r.body.totals.calls).toBe(0)
  })

  it('rejects a malformed window with 400', async () => {
    const token = await h.token('acme-user', ['ai:read'], { tenant: 'acme' })
    const r = await h.req<{ error: { code: string } }>('/api/v1/ai/usage?to=garbage', { token })
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('INVALID_ARGUMENT')
  })
})
