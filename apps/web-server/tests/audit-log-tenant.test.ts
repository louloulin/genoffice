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

describe('audit log export tenant filter (sdk1 §11.56)', () => {
  it('exportAudit() without tenantId returns records from all tenants', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    const result = await exportAudit({ format: 'json' })
    expect(result.recordCount).toBe(2)
  })

  it('exportAudit() filters by tenantId (json)', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    recordAudit({ action: 'file.saved', resource: 'c.docx' })
    const acme = await exportAudit({ format: 'json', tenantId: 'acme' })
    expect(acme.recordCount).toBe(1)
    const body = JSON.parse(acme.body!) as Array<{ resource: string; tenantId: string }>
    expect(body[0].resource).toBe('a.docx')
    expect(body[0].tenantId).toBe('acme')
  })

  it('exportAudit() filters by tenantId (csv)', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx', tenantId: 'acme' })
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'globex' })
    const result = await exportAudit({ format: 'csv', tenantId: 'acme' })
    expect(result.recordCount).toBe(1)
    expect(result.body).toMatch(/^id,tenantId,userId,/)
    // Only one data row (the header is also a line, so 2 lines total).
    const lines = result.body!.split('\n').filter((l) => l.trim())
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain(',a.docx,')
    expect(lines[1]).toContain(',acme,')
  })

  it('exportAudit() empty-string tenantId maps to default tenant', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx' }) // default
    recordAudit({ action: 'file.saved', resource: 'b.docx', tenantId: 'acme' })
    const result = await exportAudit({ format: 'json', tenantId: '' })
    expect(result.recordCount).toBe(1)
    const body = JSON.parse(result.body!) as Array<{ resource: string }>
    expect(body[0].resource).toBe('a.docx')
  })

  it('exportAudit() unknown tenantId returns empty (no false-positive default)', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.docx' })
    const result = await exportAudit({ format: 'json', tenantId: 'does-not-exist' })
    expect(result.recordCount).toBe(0)
  })
})


describe('audit log metrics byTenant (sdk1 §11.57)', () => {
  it('auditMetrics().byTenant reflects the in-memory ring composition', async () => {
    const { recordAudit, auditMetrics } = await loadModule()
    recordAudit({ action: 'a', resource: '1', tenantId: 'acme' })
    recordAudit({ action: 'a', resource: '2', tenantId: 'acme' })
    recordAudit({ action: 'a', resource: '3', tenantId: 'globex' })
    recordAudit({ action: 'a', resource: '4' }) // default tenant
    const m = auditMetrics()
    expect(m.byTenant).toEqual({ acme: 2, globex: 1, default: 1 })
    expect(m.records).toBe(4)
  })

  it('auditMetrics().byTenant is empty {} when no records exist', async () => {
    const { auditMetrics } = await loadModule()
    const m = auditMetrics()
    expect(m.byTenant).toEqual({})
    expect(m.records).toBe(0)
  })

  it('auditMetrics().byTenant reflects disk round-trip after restart', async () => {
    const { recordAudit } = await loadModule()
    recordAudit({ action: 'a', resource: '1', tenantId: 'acme' })
    recordAudit({ action: 'a', resource: '2', tenantId: 'globex' })
    // Force module re-load to hydrate from disk
    vi.resetModules()
    const { auditMetrics } = await loadModule()
    expect(auditMetrics().byTenant).toEqual({ acme: 1, globex: 1 })
  })
})


describe('audit log xlsx export (sdk1 §11.58)', () => {
  it('exportAudit({ format: xlsx }) returns base64-encoded body, no fake downloadUrl', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'a.xlsx', tenantId: 'acme' })
    recordAudit({ action: 'file.deleted', resource: 'b.xlsx', tenantId: 'globex' })
    const result = await exportAudit({ format: 'xlsx' })
    expect(result.format).toBe('xlsx')
    expect(result.recordCount).toBe(2)
    expect(result.bodyEncoding).toBe('base64')
    expect(typeof result.body).toBe('string')
    expect(result.body!.length).toBeGreaterThan(0)
    // No more fake downloadUrl — the body ships inline.
    expect(result.downloadUrl).toBeUndefined()
    // Decoding the base64 should yield a real xlsx file (OOXML zip starts with "PK")
    const decoded = Buffer.from(result.body!, 'base64')
    expect(decoded[0]).toBe(0x50) // 'P'
    expect(decoded[1]).toBe(0x4b) // 'K'
  })

  it('exportAudit xlsx respects tenantId filter', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'a', resource: 'a', tenantId: 'acme' })
    recordAudit({ action: 'a', resource: 'b', tenantId: 'globex' })
    const acme = await exportAudit({ format: 'xlsx', tenantId: 'acme' })
    expect(acme.recordCount).toBe(1)
    const decoded = Buffer.from(acme.body!, 'base64')
    expect(decoded[0]).toBe(0x50)
    expect(decoded[1]).toBe(0x4b)
  })

  it('exportAudit xlsx with no matching records returns empty body (no throw)', async () => {
    const { exportAudit } = await loadModule()
    const result = await exportAudit({ format: 'xlsx', tenantId: 'does-not-exist' })
    expect(result.recordCount).toBe(0)
    expect(result.body).toBe('')
  })

  it('exportAudit csv / json still work as utf-8 plaintext (no bodyEncoding flag)', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'a', resource: 'a' })
    const csv = await exportAudit({ format: 'csv' })
    expect(csv.bodyEncoding).toBeUndefined()
    expect(csv.body).toMatch(/^id,tenantId,userId,action,resource,resourceId,timestamp,status/)
    const json = await exportAudit({ format: 'json' })
    expect(json.bodyEncoding).toBeUndefined()
    expect(JSON.parse(json.body!)).toHaveLength(1)
  })
})

})
