/**
 * Unit coverage for the `GET /api/v1/ai/usage` handler (A18 / A22 / A62 / A63).
 *
 * Drives `handleAiUsage` directly with a minimal fake request/response so the
 * scope gate, the `tenant` narrow-widening rule, the time-window parsing and
 * the per-tenant aggregation are all exercised without booting the bundle or a
 * provider. The routing glue (that the v1 dispatcher actually reaches this
 * handler) is covered end-to-end in `ai-usage-query-e2e.test.ts`.
 *
 * Isolation: per-case TMP DATA_DIR + vi.resetModules, so the usage store and
 * the JWT secret are owned per case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const SECRET = 'usage-query-test-secret'

class FakeRes {
  statusCode = 0
  headers: Record<string, unknown> = {}
  body = ''
  writeHead(status: number, headers?: Record<string, unknown>): this {
    this.statusCode = status
    if (headers) Object.assign(this.headers, headers)
    return this
  }
  setHeader(key: string, value: unknown): void {
    this.headers[key] = value
  }
  end(chunk?: unknown): void {
    if (chunk !== undefined) this.body = String(chunk)
  }
}

function fakeReq(url: string, headers: Record<string, string>): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage
}

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ai-usage-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_USAGE_PERSIST', '1')
  vi.stubEnv('GENOFFICE_JWT_SECRET', SECRET)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadHandler() {
  return await import('../src/api/v1/ai')
}

async function mint(props: {
  sub: string
  tenant?: string
  scope?: string[]
}): Promise<string> {
  const { signJwt } = await import('../src/api/v1/auth')
  const now = Math.floor(Date.now() / 1000)
  return signJwt({
    sub: props.sub,
    ...(props.tenant ? { tenant: props.tenant } : {}),
    ...(props.scope ? { scope: props.scope } : {}),
    iat: now,
    exp: now + 600,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
}

function invoke(handler: any, url: string, token?: string): { status: number; json: any; res: FakeRes } {
  const res = new FakeRes()
  handler({
    request: fakeReq(url, token ? { authorization: `Bearer ${token}` } : {}),
    response: res as unknown as ServerResponse,
  })
  let json: any = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, json, res }
}

describe('GET /api/v1/ai/usage (handler)', () => {
  it('rejects an unauthenticated caller with 401', async () => {
    const { handleAiUsage } = await loadHandler()
    const { status, json } = invoke(handleAiUsage, '/api/v1/ai/usage')
    expect(status).toBe(401)
    expect(json.error.code).toBe('UNAUTHENTICATED')
  })

  it('rejects a token missing ai:read with 403', async () => {
    const { handleAiUsage } = await loadHandler()
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['files:read'] })
    const { status, json } = invoke(handleAiUsage, '/api/v1/ai/usage', token)
    expect(status).toBe(403)
    expect(json.error.code).toBe('FORBIDDEN')
  })

  it('returns the caller its own tenant aggregate', async () => {
    const { handleAiUsage } = await loadHandler()
    const { recordUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', promptTokens: 5, totalTokens: 5 })
    recordUsage({ tenantId: 'globex', endpoint: '/api/ai/stream', promptTokens: 9, totalTokens: 9 })
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['ai:read'] })

    const { status, json } = invoke(handleAiUsage, '/api/v1/ai/usage', token)
    expect(status).toBe(200)
    expect(json.tenants).toHaveLength(1)
    expect(json.tenants[0]).toMatchObject({ tenantId: 'acme', calls: 1, promptTokens: 5 })
    expect(json.totals.calls).toBe(1)
  })

  it('ignores ?tenant= for a non-operator caller (own tenant is forced)', async () => {
    const { handleAiUsage } = await loadHandler()
    const { recordUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', totalTokens: 5 })
    recordUsage({ tenantId: 'globex', endpoint: '/api/ai/stream', totalTokens: 9 })
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['ai:read'] })

    const { status, json } = invoke(handleAiUsage, '/api/v1/ai/usage?tenant=globex', token)
    expect(status).toBe(200)
    expect(json.tenants.map((t: any) => t.tenantId)).toEqual(['acme'])
  })

  it('lets an operator broaden and filter the tenant', async () => {
    const { handleAiUsage } = await loadHandler()
    const { recordUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', totalTokens: 5 })
    recordUsage({ tenantId: 'globex', endpoint: '/api/ai/stream', totalTokens: 9 })
    const operator = await mint({ sub: 'operator', scope: ['admin'] })

    const all = invoke(handleAiUsage, '/api/v1/ai/usage', operator)
    expect(all.status).toBe(200)
    expect(all.json.tenants.map((t: any) => t.tenantId)).toEqual(['acme', 'globex'])

    const onlyGlobex = invoke(handleAiUsage, '/api/v1/ai/usage?tenant=globex', operator)
    expect(onlyGlobex.status).toBe(200)
    expect(onlyGlobex.json.tenants).toHaveLength(1)
    expect(onlyGlobex.json.tenants[0].tenantId).toBe('globex')
  })

  it('honours an explicit time window', async () => {
    const { handleAiUsage } = await loadHandler()
    const { recordUsage } = await import('../src/common/usage-meter')
    recordUsage({ tenantId: 'acme', endpoint: '/api/ai/stream', totalTokens: 5 })
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['ai:read'] })

    // A window entirely in the future excludes the real (now) record.
    const future = new URLSearchParams({
      from: String(Date.now() + 120_000_000),
      to: String(Date.now() + 240_000_000),
    })
    const { status, json } = invoke(
      handleAiUsage,
      `/api/v1/ai/usage?${future.toString()}`,
      token,
    )
    expect(status).toBe(200)
    expect(json.totals.calls).toBe(0)
    expect(json.tenants).toHaveLength(0)
  })

  it('rejects a malformed from/to with 400', async () => {
    const { handleAiUsage } = await loadHandler()
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['ai:read'] })
    const { status, json } = invoke(handleAiUsage, '/api/v1/ai/usage?from=not-a-date', token)
    expect(status).toBe(400)
    expect(json.error.code).toBe('INVALID_ARGUMENT')
  })

  it('rejects a from later than to with 400', async () => {
    const { handleAiUsage } = await loadHandler()
    const token = await mint({ sub: 'acme-user', tenant: 'acme', scope: ['ai:read'] })
    const q = new URLSearchParams({ from: '2000', to: '1000' }).toString()
    const { status, json } = invoke(handleAiUsage, `/api/v1/ai/usage?${q}`, token)
    expect(status).toBe(400)
    expect(json.error.code).toBe('INVALID_ARGUMENT')
  })
})
