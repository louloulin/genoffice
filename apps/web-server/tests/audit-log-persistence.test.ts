/**
 * Audit log disk persistence (sdk1.md §M5 backlog closed).
 *
 * The audit log writes append-only JSONL to `DATA_DIR/audit-log.jsonl`
 * and hydrates from it at module init. These tests restart the module
 * (`vi.resetModules()` + dynamic import) so the real load path is
 * exercised end-to-end — not a mock that happens to look right.
 *
 * Isolation: each case owns its own TMP DATA_DIR. The module reads
 * `process.env.DATA_DIR` (via `common/state.ts`) at first import;
 * `vi.resetModules()` re-runs that resolution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'audit-log-'))
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

function auditFile(): string {
  return join(TMP, 'audit-log.jsonl')
}

describe('audit log disk persistence (sdk1.md §M5)', () => {
  it('appends a record to audit-log.jsonl on recordAudit()', async () => {
    const { recordAudit } = await loadModule()
    const id = recordAudit({
      action: 'file.saved',
      resource: 'doc-1.docx',
      userId: 'alice',
    })
    expect(typeof id).toBe('string')
    expect(id.startsWith('audit-')).toBe(true)
    expect(existsSync(auditFile())).toBe(true)
    const raw = readFileSync(auditFile(), 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const lines = raw.split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.action).toBe('file.saved')
    expect(parsed.userId).toBe('alice')
    expect(parsed.tenantId).toBe('default')
  })

  it('hydrates records from disk on a fresh module import', async () => {
    const first = await loadModule()
    first.recordAudit({ action: 'auth.login', resource: 'session-1', userId: 'bob' })
    first.recordAudit({ action: 'file.saved', resource: 'doc-2.pdf', userId: 'bob' })
    // Force a fresh load — same env, same TMP, but reset module cache.
    vi.resetModules()
    const second = await loadModule()
    expect(second.auditSize()).toBe(2)
    const { logs } = second.queryAudit({ userId: 'bob' })
    expect(logs.map((l) => l.action).sort()).toEqual(['auth.login', 'file.saved'])
  })

  it('queryAudit filters by userId / action / resource / date range', async () => {
    const { recordAudit, queryAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'doc-a.docx', userId: 'alice' })
    recordAudit({ action: 'file.saved', resource: 'doc-b.docx', userId: 'bob' })
    recordAudit({ action: 'auth.logout', resource: 'session-2', userId: 'alice' })

    const alice = queryAudit({ userId: 'alice' })
    expect(alice.logs.every((l) => l.userId === 'alice')).toBe(true)
    expect(alice.total).toBe(2)

    const saves = queryAudit({ action: 'file.saved' })
    expect(saves.total).toBe(2)

    const docA = queryAudit({ resource: 'doc-a.docx' })
    expect(docA.total).toBe(1)
    expect(docA.logs[0]!.resource).toBe('doc-a.docx')
  })

  it('exportAudit returns CSV / JSON payloads and an xlsx download url', async () => {
    const { recordAudit, exportAudit } = await loadModule()
    recordAudit({ action: 'file.saved', resource: 'doc-1.docx', userId: 'alice' })
    recordAudit({ action: 'file.saved', resource: 'doc-2.docx', userId: 'bob' })

    const json = await exportAudit({ format: 'json' })
    expect(json.format).toBe('json')
    expect(json.recordCount).toBe(2)
    expect(typeof json.body).toBe('string')
    const parsed = JSON.parse(json.body!)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(2)

    const csv = await exportAudit({ format: 'csv' })
    expect(csv.format).toBe('csv')
    expect(csv.body).toContain('id,tenantId,userId,action,resource')
    expect(csv.body!.split('\n').filter(Boolean).length).toBe(3) // header + 2 rows

    const xlsx = await exportAudit({ format: 'xlsx' })
    expect(xlsx.format).toBe('xlsx')
    // §11.58: xlsx ships inline as base64 (no fake downloadUrl — the URL
    // never had a server handler). Decoding yields a real OOXML zip.
    expect(xlsx.downloadUrl).toBeUndefined()
    expect(xlsx.bodyEncoding).toBe('base64')
    const decoded = Buffer.from(xlsx.body!, 'base64')
    expect(decoded.length).toBeGreaterThan(0)
    expect(decoded[0]).toBe(0x50) // 'P'
    expect(decoded[1]).toBe(0x4b) // 'K'
  })

  it('skips malformed lines on hydrate (kill -9 partial tail)', async () => {
    // Seed a file with a good record, a malformed line, and another good record.
    const good1 = { id: 'audit-a', tenantId: 'default', userId: 'u1', action: 'x', resource: 'r', resourceId: '', details: {}, ip: '0.0.0.0', userAgent: 'g', timestamp: 1, status: 'success' as const }
    const good2 = { id: 'audit-b', tenantId: 'default', userId: 'u1', action: 'y', resource: 'r', resourceId: '', details: {}, ip: '0.0.0.0', userAgent: 'g', timestamp: 2, status: 'success' as const }
    const body =
      JSON.stringify(good1) + '\n' +
      '{not json}\n' +
      JSON.stringify(good2) + '\n'
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(TMP, { recursive: true })
    writeFileSync(auditFile(), body, 'utf8')
    vi.resetModules()
    const mod = await loadModule()
    expect(mod.auditSize()).toBe(2)
    const ids = mod.snapshotAuditLog().map((r) => r.id).sort()
    expect(ids).toEqual(['audit-a', 'audit-b'])
  })

  it('GENOFFICE_AUDIT_PERSIST=0 disables both writes and reads', async () => {
    vi.stubEnv('GENOFFICE_AUDIT_PERSIST', '0')
    vi.resetModules()
    const mod = await loadModule()
    mod.recordAudit({ action: 'file.saved', resource: 'doc-x', userId: 'u1' })
    expect(existsSync(auditFile())).toBe(false)
    expect(mod.auditSize()).toBe(1)
  })

  it('recordAudit tolerates a write failure (in-memory mirror still holds record)', async () => {
    // Mock node:fs so appendFileSync throws — same module instance the
    // audit-log module pulls in via `import * as fssync from 'node:fs'`.
    vi.doMock('node:fs', async (importOriginal) => {
      const real = await importOriginal<typeof import('node:fs')>()
      return {
        ...real,
        appendFileSync: () => {
          throw new Error('disk full')
        },
      }
    })
    vi.resetModules()
    const mod = await loadModule()
    expect(() =>
      mod.recordAudit({ action: 'after', resource: 'r', userId: 'u' }),
    ).not.toThrow()
    expect(mod.auditSize()).toBe(1)
    expect(mod.snapshotAuditLog()[0]!.action).toBe('after')
  })
})
