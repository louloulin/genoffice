/**
 * A40–A43 round-trip against the live bundle, armed boot (WEB_TOKEN + JWT
 * secret): a tenant-scoped JWT is minted over /api/v1/auth/jwt, drives
 * ai:translate through /api/ipc, and the resulting `ai.call` audit record is
 * read back through the scope-gated audit:query — under the caller's tenant,
 * with provenance 'jwt'. The operator path (WEB_TOKEN, no JWT claims) must
 * land in the 'default' bucket marked 'fallback', never presented as a real
 * tenant's traffic. No provider is configured, so ai:translate fails
 * gracefully (result.ok === false with a reason — the failure-surfacing
 * contract) and the audit record captures the failure with its errorCode.
 *
 * Bundle-gated: skips when dist/bundle/index.js has not been built.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const WEB_TOKEN = 'op-secret-123'
const bundle = join(import.meta.dirname, '..', 'dist', 'bundle', 'index.js')

interface IpcEnvelope<T> {
  status: number
  ok?: boolean
  result?: T
  error?: { code?: string; message?: string }
}

interface AuditRecord {
  action?: string
  resource?: string
  tenantId?: string
  userId?: string
  status?: string
  details?: Record<string, unknown>
}

describe.skipIf(!existsSync(bundle))('auth tenant → audit round-trip (armed boot)', () => {
  let h: ServerHarness

  beforeAll(async () => {
    h = await ServerHarness.start({
      env: { WEB_TOKEN, GENOFFICE_AUDIT_PERSIST: '1' },
    })
  }, 30_000)

  afterAll(async () => {
    if (h) await h.stop()
  })

  async function mint(
    body: Record<string, unknown>,
  ): Promise<{ status: number; token?: string; errorCode?: string }> {
    // Minting is an operator action when WEB_TOKEN is armed — the route table
    // refuses JWTs on /api/v1/auth/jwt outright, so the guest token is minted
    // with the operator credential (the embed host's role).
    const r = await h.req<{ token?: string; error?: { code?: string } }>('/api/v1/auth/jwt', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${WEB_TOKEN}` },
      body: JSON.stringify(body),
    })
    return { status: r.status, token: r.body.token, errorCode: r.body.error?.code }
  }

  function decodePayload(token: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >
  }

  async function ipc<T>(channel: string, token: string, args: unknown[]): Promise<IpcEnvelope<T>> {
    const r = await h.req<{ ok?: boolean; result?: T; error?: { code?: string; message?: string } }>(
      `/api/ipc/${encodeURIComponent(channel)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args }),
        token,
      },
    )
    return { status: r.status, ok: r.body.ok, result: r.body.result, error: r.body.error }
  }

  it('mints tenant-scoped JWTs and rejects malformed tenant claims', async () => {
    const good = await mint({ sub: 'guest', tenant: 'acme', scope: ['ai:translate'], ttl: 600 })
    expect(good.status).toBe(200)
    const payload = decodePayload(good.token!)
    expect(payload.tenant).toBe('acme')
    expect(payload.scope).toEqual(['ai:translate'])

    for (const tenant of [42, '', 'x'.repeat(129)]) {
      const bad = await mint({ sub: 'guest', tenant, scope: ['ai:translate'] })
      expect(bad.status, `tenant=${JSON.stringify(tenant)}`).toBe(400)
      expect(bad.errorCode).toBe('INVALID_ARGUMENT')
    }
  })

  it('lands a tenant JWT ai:translate call under its tenant with jwt provenance', async () => {
    const tenantToken = await mint({ sub: 'guest', tenant: 'acme', scope: ['ai:translate'] })
    const call = await ipc<{ ok: boolean; error?: string }>('ai:translate', tenantToken.token!, [
      { instruction: 'Hello world', targetLang: 'zh-CN', sourceLang: 'en-US' },
    ])
    // Transport succeeds; the turn itself fails gracefully (no provider).
    expect(call.status).toBe(200)
    expect(call.ok).toBe(true)
    expect(call.result?.ok).toBe(false)
    expect(call.result?.error).toBeTruthy()

    const auditor = await h.token('auditor', ['audit:read'])
    const q = await ipc<{ logs: AuditRecord[] }>('audit:query', auditor, [
      { action: 'ai.call', tenantId: 'acme' },
    ])
    expect(q.status).toBe(200)
    expect(q.result?.logs).toHaveLength(1)
    const rec = q.result!.logs[0]!
    expect(rec.tenantId).toBe('acme')
    expect(rec.userId).toBe('guest')
    expect(rec.resource).toBe('ai:translate')
    expect(rec.status).toBe('failure')
    expect(rec.details).toMatchObject({
      tenantSource: 'jwt',
      errorCode: 'translate_error',
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
    })

    // A41: another tenant's query sees nothing of acme's traffic.
    const other = await ipc<{ logs: AuditRecord[] }>('audit:query', auditor, [
      { action: 'ai.call', tenantId: 'globex' },
    ])
    expect(other.result?.logs).toHaveLength(0)
  })

  it('lands operator (WEB_TOKEN) calls in the default bucket with fallback provenance', async () => {
    const call = await ipc<{ ok: boolean; error?: string }>('ai:translate', WEB_TOKEN, [
      { instruction: 'Hello operator', targetLang: 'zh-CN', sourceLang: 'en-US' },
    ])
    expect(call.status).toBe(200)
    expect(call.result?.ok).toBe(false)

    const auditor = await h.token('auditor', ['audit:read'])
    const q = await ipc<{ logs: AuditRecord[] }>('audit:query', auditor, [
      { action: 'ai.call', tenantId: 'default' },
    ])
    expect(q.status).toBe(200)
    expect(q.result?.logs).toHaveLength(1)
    const rec = q.result!.logs[0]!
    expect(rec.tenantId).toBe('default')
    expect(rec.resource).toBe('ai:translate')
    // No JWT behind the operator token: provenance must say fallback, and the
    // audit layer's no-caller default author applies.
    expect(rec.details).toMatchObject({ tenantSource: 'fallback' })
    expect(rec.userId).toBe('system')
  })

  it('gates audit:query behind the audit:read scope', async () => {
    const outsider = await h.token('peeker', ['files:read'])
    const res = await ipc('audit:query', outsider, [{ action: 'ai.call' }])
    expect(res.status).toBe(403)
  })
})
