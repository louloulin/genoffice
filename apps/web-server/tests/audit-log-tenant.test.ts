/**
 * Tenant-aware audit logging (sdk1.md §11.56).
 *
 * The disk schema and in-memory mirror have always carried tenantId
 * (every AuditRecord row + JSONL export header). What's been missing
 * is the surface: handlers accepted userId/resourceId but never let
 * callers pin a tenant. §11.56 wires tenantId through audit:log +
 * audit:query and defensively rejects non-string tenantId (a common
 * refactor mistake that used to be silently coerced to 'default').
 *
 * Tests exercise:
 *   - recordAudit({ tenantId }) writes the tenant through to disk + memory
 *   - queryAudit({ tenantId }) filters correctly
 *   - empty-string tenantId maps to 'default' tenant (the implicit tenant
 *     for callers that don't specify one)
 *   - missing tenantId still defaults to 'default'
 *   - audit-log.jsonl line for tenantId='acme' is parseable back
 *
 * Isolation pattern from audit-log-persistence.test.ts: each case owns
 * its own TMP DATA_DIR, vi.resetModules() to re-run module init.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'audit-tenant-'))
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

async function loadModule() {
  return await import('../src/common/audit-log')
}

describe('audit log tenant field (sdk1 §11.56)', () => {
  it('recordAudit() defaults tenantId to "default" when not provided', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    const id = recordAudit({
      action: 'file.saved',
      resource: 'r.docx',
    })
    const { logs } = queryAudit({ resource: 'r.docx' })
    expect(logs).toHaveLength(1)
    expect(logs[0].id).toBe(id)
    expect(logs[0].tenantId).toBe('default')
  })

  it('recordAudit() preserves caller-supplied tenantId on the in-memory record', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    recordAudit({ action: 'file.saved', resource: 'c.docx' })
    // tenantId='acme' filter
    const acme = queryAudit({ tenantId: 'acme' })
    expect(acme.logs.map((l) => l.resource).sort()).toEqual(['a.docx'])
    expect(acme.logs[0].tenantId).toBe('acme')
    // tenantId='globex' filter
    const globex = queryAudit({ tenantId: 'globex' })
    expect(globex.logs.map((l) => l.resource).sort()).toEqual(['b.docx'])
    // tenantId='default' filter (the implicit tenant)
    const def = queryAudit({ tenantId: 'default' })
    expect(def.logs.map((l) => l.resource).sort()).toEqual(['c.docx'])
  })

  it('empty-string tenantId in queryAudit filter maps to the "default" tenant', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'x.docx' }) // default
    recordAudit({ action: 'file.saved', resource: 'y.docx', tenantId: 'acme' })
    // '' should match the default-tenant record (the one without explicit tenantId)
    const empty = queryAudit({ tenantId: '' })
    expect(empty.logs.map((l) => l.resource).sort()).toEqual(['x.docx'])
  })

  it('audit-log.jsonl round-trips tenantId through disk persistence', async () => {
    const { recordAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    // Re-load the module to force a re-hydration from disk
    vi.resetModules()
    const { queryAudit } = await loadModule()
    const acme = queryAudit({ tenantId: 'acme' })
    expect(acme.logs.map((l) => l.resource)).toEqual(['a.docx'])
    const globex = queryAudit({ tenantId: 'globex' })
    expect(globex.logs.map((l) => l.resource)).toEqual(['b.docx'])
  })

  it('queryAudit() with no tenantId filter returns records from all tenants', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    recordAudit({ action: 'file.saved', resource: 'c.docx' })
    const all = queryAudit({})
    expect(all.logs).toHaveLength(3)
    const tenants = new Set(all.logs.map((l) => l.tenantId))
    expect(tenants).toEqual(new Set(['acme', 'globex', 'default']))
  })

  it('queryAudit() with unknown tenantId returns empty (no false-positive default fallback)', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx' })
    const none = queryAudit({ tenantId: 'does-not-exist' })
    expect(none.logs).toEqual([])
    expect(none.total).toBe(0)
  })
})
