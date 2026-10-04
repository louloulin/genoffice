/**
 * A40 tenant claim: the unit-level links of the threading chain.
 *
 *   signJwt({tenant}) → verifyJwtWithRevocation → tenantFromPayload
 *   invokeIpc(eventOverrides.tenantId) → the handler's event
 *
 * The HTTP-level round-trip (mint over /api/v1/auth/jwt, dispatch through
 * /api/ipc, read the audit record back) lives in auth-tenant-audit-e2e.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'tenant-threading-'))
  vi.stubEnv('GENOFFICE_JWT_SECRET', 'tenant-threading-test-secret')
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

describe('A40 tenant claim', () => {
  it('survives the sign → verify round-trip and stays absent when unset', async () => {
    const { signJwt, verifyJwtWithRevocation } = await import('../src/api/v1/auth')
    const withTenant = verifyJwtWithRevocation(
      signJwt({
        sub: 'guest',
        tenant: 'acme',
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 600,
        iss: 'genoffice',
        aud: 'genoffice-web',
      }),
    )
    expect(withTenant?.tenant).toBe('acme')

    const withoutTenant = verifyJwtWithRevocation(
      signJwt({
        sub: 'guest',
        iat: 0,
        exp: Math.floor(Date.now() / 1000) + 600,
        iss: 'genoffice',
        aud: 'genoffice-web',
      }),
    )
    expect(withoutTenant?.tenant).toBeUndefined()
  })

  it('tenantFromPayload resolves the claim and falls back to default', async () => {
    const { tenantFromPayload } = await import('../src/auth/route-policy')
    expect(tenantFromPayload({ tenant: 'acme' })).toBe('acme')
    expect(tenantFromPayload({})).toBe('default')
    expect(tenantFromPayload(null)).toBe('default')
    expect(tenantFromPayload(undefined)).toBe('default')
  })

  it('invokeIpc threads tenantId onto the handler event', async () => {
    const { registerHandle } = await import('../src/common/index')
    const { invokeIpc } = await import('../src/api/v1/ipc-bridge')
    let seen: unknown
    registerHandle('test:tenant-thread', (event: unknown) => {
      seen = event
      return { ok: true }
    })
    await invokeIpc('test:tenant-thread', [], { userId: 'u1', tenantId: 'acme' })
    expect(seen).toMatchObject({ userId: 'u1', tenantId: 'acme' })

    await invokeIpc('test:tenant-thread', [])
    expect(seen).not.toHaveProperty('tenantId')
  })
})
