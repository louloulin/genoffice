/**
 * Unit coverage for the AI usage meter (A18 / A22 / A62 / A63).
 *
 * Proves three things without booting the bundle:
 *   1. `recordUsage` stores provider/model/tokens/latency/tenant/endpoint and
 *      leaves genuinely-unknown counts *absent* rather than inventing zeros.
 *   2. `aggregateUsage` groups per tenant and honours an explicit time window.
 *   3. `auditAiCall` — the single choke point every AI surface funnels through —
 *      feeds one usage entry per audited call, so the meter can't drift from
 *      the audit trail.
 *
 * Isolation: per-case TMP DATA_DIR + vi.resetModules, matching the pattern in
 * `ai-audit.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'usage-meter-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_USAGE_PERSIST', '1')
  vi.stubEnv('GENOFFICE_AUDIT_PERSIST', '1')
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('recordUsage', () => {
  it('stores provider/model/tokens/latency/tenant/endpoint for one AI call', async () => {
    const { recordUsage, queryUsage } = await import('../src/common/usage-meter')
    recordUsage({
      tenantId: 'acme',
      endpoint: '/api/ai/stream',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      latencyMs: 250,
    })
    const { records, total } = queryUsage({ tenantId: 'acme' })
    expect(total).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      tenantId: 'acme',
      endpoint: '/api/ai/stream',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      latencyMs: 250,
    })
    expect(typeof records[0].timestamp).toBe('number')
  })

  it('leaves unknown token counts absent instead of inventing numbers', async () => {
    const { recordUsage, queryUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: 'ai:translate', provider: 'deepseek' })
    const { records } = queryUsage({ tenantId: 'acme' })
    expect(records[0].promptTokens).toBeUndefined()
    expect(records[0].completionTokens).toBeUndefined()
    expect(records[0].totalTokens).toBeUndefined()
    expect(records[0].latencyMs).toBeUndefined()
    expect(records[0].provider).toBe('deepseek')
  })

  it('defaults a missing tenant to "default"', async () => {
    const { recordUsage, queryUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: '  ', endpoint: '/api/ai/stream' })
    const { records } = queryUsage({})
    expect(records[0].tenantId).toBe('default')
  })
})

describe('aggregateUsage', () => {
  it('groups per tenant and honours the time window', async () => {
    const { recordUsage, aggregateUsage } = await import('../src/common/usage-meter')
    const t1 = 1_000_000
    const t2 = 2_000_000
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 100, timestamp: t1 })
    recordUsage({ tenantId: 'globex', endpoint: '/api/ai/stream', promptTokens: 1, completionTokens: 1, totalTokens: 2, latencyMs: 50, timestamp: t1 })
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', promptTokens: 20, completionTokens: 10, totalTokens: 30, latencyMs: 300, timestamp: t2 })

    // Window that contains only t1.
    const win1 = aggregateUsage({ fromMs: t1, toMs: t1 })
    expect(win1.tenants).toEqual([
      { tenantId: 'acme', calls: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15, avgLatencyMs: 100 },
      { tenantId: 'globex', calls: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2, avgLatencyMs: 50 },
    ])
    expect(win1.totals).toEqual({ calls: 2, promptTokens: 11, completionTokens: 6, totalTokens: 17 })

    // Window that contains only t2 — the t1 call must be filtered out.
    const win2 = aggregateUsage({ fromMs: t2, toMs: t2 })
    expect(win2.tenants).toHaveLength(1)
    expect(win2.tenants[0]).toMatchObject({ tenantId: 'acme', calls: 1, totalTokens: 30 })

    // A window that excludes everything.
    const empty = aggregateUsage({ fromMs: t2 + 1, toMs: t2 + 5_000 })
    expect(empty.tenants).toHaveLength(0)
    expect(empty.totals.calls).toBe(0)
  })

  it('scopes to a single tenant when tenantId is supplied', async () => {
    const { recordUsage, aggregateUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', promptTokens: 10, completionTokens: 5, totalTokens: 15, latencyMs: 100 })
    recordUsage({ tenantId: 'globex', endpoint: '/api/ai/stream', promptTokens: 7, completionTokens: 3, totalTokens: 10, latencyMs: 500 })
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', promptTokens: 20, completionTokens: 10, totalTokens: 30, latencyMs: 300 })

    const acme = aggregateUsage({ tenantId: 'acme' })
    expect(acme.tenants).toHaveLength(1)
    expect(acme.tenants[0]).toMatchObject({ tenantId: 'acme', calls: 2, promptTokens: 30, completionTokens: 15, totalTokens: 45 })
    expect(acme.totals).toEqual({ calls: 2, promptTokens: 30, completionTokens: 15, totalTokens: 45 })
  })
})

describe('auditAiCall feeds the usage meter', () => {
  it('records one usage entry per audited AI call', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryUsage, usageSize } = await import('../src/common/usage-meter')
    auditAiCall({
      endpoint: '/api/ai/stream',
      tenantId: 'acme',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      durationMs: 250,
      ok: true,
    })
    expect(usageSize()).toBe(1)
    const { records } = queryUsage({ tenantId: 'acme' })
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      tenantId: 'acme',
      endpoint: '/api/ai/stream',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      latencyMs: 250,
    })
  })

  it('still writes exactly one audit record (meter does not disturb the audit trail)', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({ endpoint: '/api/v1/ai/chat', tenantId: 'acme', ok: false, errorCode: 'PROVIDER_ERROR' })
    const { logs } = queryAudit({ action: 'ai.call' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatchObject({ action: 'ai.call', resource: '/api/v1/ai/chat', status: 'failure' })
  })
})
