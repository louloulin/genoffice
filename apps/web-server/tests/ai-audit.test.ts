/**
 * The `ai.call` audit helper (A43).
 *
 * Every AI surface funnels through auditAiCall so consumers can rely on one
 * record shape: tenant, endpoint, provider/model, token usage (null when the
 * call path cannot surface it), duration, status, and — critically for A42 —
 * tenant provenance. A 'default' tenant with no JWT behind it must be marked
 * 'fallback', never presented as a real tenant's traffic.
 *
 * Isolation pattern from audit-log-tenant.test.ts: per-case TMP DATA_DIR,
 * GENOFFICE_AUDIT_PERSIST=1, vi.resetModules() so each case owns its log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ai-audit-'))
  vi.stubEnv('GENOFFICE_AUDIT_PERSIST', '1')
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('auditAiCall (A43)', () => {
  it('records tenant + provenance + token usage for a JWT-backed call', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({
      endpoint: 'ai:chat',
      tenantId: 'acme',
      userId: 'user-1',
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      durationMs: 250,
      ok: true,
    })
    const { logs } = queryAudit({ resource: 'ai:chat' })
    expect(logs).toHaveLength(1)
    const rec = logs[0]
    expect(rec.action).toBe('ai.call')
    expect(rec.tenantId).toBe('acme')
    expect(rec.userId).toBe('user-1')
    expect(rec.status).toBe('success')
    expect(rec.details).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      promptTokens: 11,
      completionTokens: 4,
      totalTokens: 15,
      durationMs: 250,
      tenantSource: 'jwt',
    })
  })

  it('marks a call without tenantId as the default bucket with fallback provenance', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({ endpoint: 'ai:translate', provider: 'deepseek', ok: true, durationMs: 80 })
    const { logs } = queryAudit({ resource: 'ai:translate' })
    expect(logs).toHaveLength(1)
    expect(logs[0].tenantId).toBe('default')
    expect(logs[0].details).toMatchObject({ tenantSource: 'fallback' })
    // Token fields stay present (null) so consumers can rely on the shape.
    expect(logs[0].details).toMatchObject({
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    })
  })

  it('trims whitespace tenant and never mistakes it for a fallback', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({ endpoint: '/api/v1/ai/chat', tenantId: '  acme  ', ok: true })
    const { logs } = queryAudit({ resource: '/api/v1/ai/chat' })
    expect(logs[0].tenantId).toBe('acme')
    expect(logs[0].details).toMatchObject({ tenantSource: 'jwt' })
  })

  it('records failures with errorCode and status failure', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({
      endpoint: 'ai:chat',
      tenantId: 'acme',
      provider: 'kimi',
      ok: false,
      errorCode: 'credits',
      durationMs: 40,
    })
    const { logs } = queryAudit({ resource: 'ai:chat' })
    expect(logs[0].status).toBe('failure')
    expect(logs[0].details).toMatchObject({ errorCode: 'credits', provider: 'kimi' })
  })

  it('keeps two tenants isolated in the same log (A41)', async () => {
    const { auditAiCall } = await import('../src/ai/ai-audit')
    const { queryAudit } = await import('../src/common/audit-log')
    auditAiCall({ endpoint: 'ai:chat', tenantId: 'acme', ok: true })
    auditAiCall({ endpoint: 'ai:chat', tenantId: 'globex', ok: true })
    const acme = queryAudit({ tenantId: 'acme' })
    const globex = queryAudit({ tenantId: 'globex' })
    expect(acme.logs).toHaveLength(1)
    expect(globex.logs).toHaveLength(1)
    expect(acme.logs[0].details).toMatchObject({ tenantSource: 'jwt' })
    expect(globex.logs[0].details).toMatchObject({ tenantSource: 'jwt' })
  })
})

describe('tenantContextFromEvent (A40 → A42)', () => {
  it('extracts and trims the tenant claim off the synthesized event', async () => {
    const { tenantContextFromEvent } = await import('../src/ai/ai-audit')
    expect(tenantContextFromEvent({ tenantId: ' acme ', userId: 'u1' })).toEqual({ tenantId: 'acme' })
  })

  it('returns an empty context when the event carries no usable tenant', async () => {
    const { tenantContextFromEvent } = await import('../src/ai/ai-audit')
    expect(tenantContextFromEvent({})).toEqual({})
    expect(tenantContextFromEvent({ tenantId: '   ' })).toEqual({})
    expect(tenantContextFromEvent({ tenantId: 42 })).toEqual({})
    expect(tenantContextFromEvent(null)).toEqual({})
    expect(tenantContextFromEvent(undefined)).toEqual({})
  })
})

/**
 * A43 coverage for the image path: the renderer calls the `ai:fetch-image` IPC
 * channel directly, so the record must be written by the handler — not only by
 * the HTTP wrapper, which reaches the same handler through `invokeIpc`.
 */
describe('AI surfaces write ai.call records (A43)', () => {
  const unroutable = 'http://127.0.0.1:9/nope.png'

  it('the IPC ai:fetch-image handler audits the renderer image path', async () => {
    const { registerAiCoreHandlers } = await import('../src/ai/chat')
    const { invokeIpc } = await import('../src/api/v1/ipc-bridge')
    const { queryAudit } = await import('../src/common/audit-log')
    registerAiCoreHandlers()

    // The target is unroutable, so the fetch fails — but the failure record
    // must still exist, tagged with the caller's tenant.
    await invokeIpc('ai:fetch-image', [unroutable], { tenantId: 'acme' })

    const { logs } = queryAudit({ resource: 'ai:fetch-image' })
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('ai.call')
    expect(logs[0].tenantId).toBe('acme')
    expect(logs[0].status).toBe('failure')
  })

  it('names the HTTP route when the wrapper dispatches through the handler', async () => {
    const { registerAiCoreHandlers } = await import('../src/ai/chat')
    const { invokeIpc } = await import('../src/api/v1/ipc-bridge')
    const { queryAudit } = await import('../src/common/audit-log')
    registerAiCoreHandlers()

    await invokeIpc('ai:fetch-image', [unroutable], {
      tenantId: 'acme',
      auditEndpoint: '/api/v1/ai/image',
    })

    // One record, attributed to the caller-facing route, none to the bare IPC
    // channel (no double-count when HTTP wraps IPC).
    expect(queryAudit({ resource: '/api/v1/ai/image' }).logs).toHaveLength(1)
    expect(queryAudit({ resource: 'ai:fetch-image' }).logs).toHaveLength(0)
  })
})
