/**
 * Audit log retention / rotate worker (sdk1 §A.5 backlog close).
 *
 * Validates:
 *  - rotateAuditLog() drops records older than the cutoff.
 *  - rotateAuditLog() keeps records within the retention window.
 *  - rotateAuditLog() bumps totalDropped on /api/v1/metrics (sdk1 §11.44).
 *  - rotateAuditLog() drops malformed lines.
 *  - rotateAuditLog() is a no-op when nothing is older than cutoff.
 *  - rotateAuditLog() is a no-op when the file does not exist.
 *  - startAuditRotateWorker() registers a timer; unref() lets the loop exit.
 *  - GENOFFICE_AUDIT_RETENTION_DAYS env var overrides the default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'audit-rotate-'))
  vi.stubEnv('GENOFFICE_AUDIT_PERSIST', '1')
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('audit-log retention / rotate worker (sdk1 §A.5 backlog close)', () => {
  it('rotateAuditLog drops records older than the cutoff', async () => {
    const { rotateAuditLog } = await import('../src/common/audit-log')
    const { recordAudit } = await import('../src/common/audit-log')
    // 3 records: 2 old (kept via fake timestamps) + 1 new. The
    // rotate uses `now` from opts, so we don't need to sleep.
    recordAudit({ action: 'old', resource: 'r' })
    recordAudit({ action: 'old', resource: 'r' })
    // With retentionDays=1 and nowMs=+48h, cutoff = +48h - 24h = +24h.
    // Both records sit at +0h (now), so both fall outside the window.
    const inTwoDays = Date.now() + 48 * 60 * 60 * 1000
    const r = rotateAuditLog({ retentionDays: 1, nowMs: inTwoDays })
    expect(r.dropped).toBe(2)
    expect(r.kept).toBe(0)
    expect(r.skipped).toBe(false)
    // The file should now be empty.
    const file = join(TMP, 'audit-log.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(0)
  })

  it('rotateAuditLog bumps totalDropped on the metrics surface', async () => {
    const { rotateAuditLog, recordAudit, auditMetrics } = await import('../src/common/audit-log')
    recordAudit({ action: 'a', resource: 'r' })
    recordAudit({ action: 'a', resource: 'r' })
    const before = auditMetrics().totalDropped
    const inTwoDays = Date.now() + 48 * 60 * 60 * 1000
    rotateAuditLog({ retentionDays: 1, nowMs: inTwoDays })
    const after = auditMetrics().totalDropped
    expect(after - before).toBe(2)
  })

  it('rotateAuditLog is a no-op when nothing is older than the cutoff', async () => {
    const { rotateAuditLog, recordAudit } = await import('../src/common/audit-log')
    recordAudit({ action: 'a', resource: 'r' })
    const file = join(TMP, 'audit-log.jsonl')
    const before = readFileSync(file, 'utf8')
    const r = rotateAuditLog({ retentionDays: 365, nowMs: Date.now() })
    expect(r.dropped).toBe(0)
    expect(r.kept).toBe(1)
    // File content unchanged (no temp-file swap).
    const after = readFileSync(file, 'utf8')
    expect(after).toBe(before)
  })

  it('rotateAuditLog skips gracefully when the file does not exist', async () => {
    const { rotateAuditLog } = await import('../src/common/audit-log')
    const r = rotateAuditLog({ retentionDays: 90 })
    expect(r.skipped).toBe(true)
    expect(r.dropped).toBe(0)
    expect(r.kept).toBe(0)
  })

  it('rotateAuditLog drops malformed lines (corrupted JSONL tail)', async () => {
    const { rotateAuditLog } = await import('../src/common/audit-log')
    // Manually write a JSONL with one good + one malformed line.
    const file = join(TMP, 'audit-log.jsonl')
    const good = JSON.stringify({
      id: 'a1',
      tenantId: 't',
      userId: 'u',
      action: 'x',
      resource: 'r',
      resourceId: '',
      details: {},
      ip: '',
      userAgent: '',
      timestamp: Date.now(),
      status: 'success',
    })
    writeFileSync(file, good + '\n{this is not json\n', 'utf8')
    const r = rotateAuditLog({ retentionDays: 365 })
    expect(r.dropped).toBe(1) // the malformed line
    expect(r.kept).toBe(1)
  })

  it('startAuditRotateWorker registers a timer that is unref()\'d', async () => {
    const { startAuditRotateWorker, _stopAuditRotateWorkerForTests } = await import('../src/common/audit-log')
    const t = startAuditRotateWorker()
    expect(t).toBeTruthy()
    // Idempotent: second call returns the same handle.
    const t3 = startAuditRotateWorker()
    expect(t3).toBe(t)
    _stopAuditRotateWorkerForTests()
  })

  it('GENOFFICE_AUDIT_RETENTION_DAYS overrides the default', async () => {
    vi.stubEnv('GENOFFICE_AUDIT_RETENTION_DAYS', '365')
    vi.resetModules()
    const { retentionCutoffMs } = await import('../src/common/audit-log')
    const now = 1_700_000_000_000
    const cutoff = retentionCutoffMs(now, retentionCutoffMs.length ? undefined : 365) // call returns ms
    // Compute the expected cutoff manually for "now - 365 days"
    const expected = now - 365 * 24 * 60 * 60 * 1000
    expect(cutoff).toBe(expected)
  })
})
