/**
 * Disk-backed audit log (sdk1.md §11.3 M5 + §C M5 backlog).
 *
 * The previous implementation stored audit records in a process-local
 * `AUDIT_LOGS: Map<string, AuditRecord>` in `common/state.ts`. That was
 * fine for a stub but meant a server restart wiped the entire audit
 * trail — exactly the wrong time for compliance data to disappear.
 *
 * This module replaces it with an append-only JSONL log at
 * `DATA_DIR/audit-log.jsonl`. Each record is one JSON line; we keep a
 * bounded in-memory mirror (newest 10 000 records) for fast query so
 * `audit:query` doesn't have to re-read the file every call. Persisting
 * is best-effort: a write failure logs a warning but never throws, so
 * a flaky disk can't stall `audit:log` calls coming through from the
 * save pipeline.
 *
 * The on-disk shape is intentionally simple — no envelopes, no headers,
 * just `JSON.stringify(record) + '\n'`. That makes the file easy to
 * inspect with `jq`, `tail -f`, or any log shipper (Filebeat /
 * Vector / Loki) without a custom parser. A `version` marker would be
 * overkill at this size; if the schema ever changes, we can rename to
 * `audit-log.v2.jsonl` and ship a one-shot migrator.
 *
 * Concurrency: single-process Node, so the in-memory array is the
 * authoritative source and the file is just a write-through cache. If
 * we ever go multi-process (M4+ cluster mode), switch to a SQLite or
 * Postgres backend — JSONL is not safe under concurrent appenders.
 *
 * Set `GENOFFICE_AUDIT_PERSIST=0` to disable persistence (used by
 * tests that don't want disk writes to escape their TMP DATA_DIR).
 */

// Use the namespace import so vi.mock('node:fs') can intercept the
// underlying binding (named-import bindings are read-only on the
// module namespace object, but namespace objects are mutable).
import * as fssync from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './state'

export interface AuditRecord {
  id: string
  tenantId: string
  userId: string
  action: string
  resource: string
  resourceId: string
  details: Record<string, unknown>
  ip: string
  userAgent: string
  timestamp: number
  status: 'success' | 'failure'
}

export interface RecordAuditInput {
  tenantId?: string
  userId?: string
  action: string
  resource: string
  resourceId?: string
  details?: Record<string, unknown>
  ip?: string
  userAgent?: string
  status?: 'success' | 'failure'
}

export interface QueryAuditFilters {
  userId?: string
  action?: string
  resource?: string
  startDate?: number
  endDate?: number
  limit?: number
  offset?: number
}

export interface ExportAuditFilters {
  format?: 'csv' | 'json' | 'xlsx'
  startDate?: number
  endDate?: number
}

const FILE = join(DATA_DIR, 'audit-log.jsonl')
const MAX_RECORDS = 10_000
const PERSIST_DISABLED = process.env.GENOFFICE_AUDIT_PERSIST === '0'

/** In-memory mirror, newest first. Bounded by `MAX_RECORDS`. */
const records: AuditRecord[] = []
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  if (PERSIST_DISABLED) return
  if (!fssync.existsSync(FILE)) return
  try {
    const raw = fssync.readFileSync(FILE, 'utf8')
    if (!raw.trim()) return
    const lines = raw.split('\n')
    // Iterate from the end so the in-memory array stays newest-first
    // without sorting; we trim by length once parsing is done.
    const parsed: AuditRecord[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as AuditRecord
        if (rec && typeof rec === 'object' && typeof rec.id === 'string') {
          parsed.push(rec)
        }
        // Malformed lines are silently skipped: the previous design
        // crashed boot on a single bad entry, which is wrong for a
        // log file (a partial tail from `kill -9` is normal).
      } catch {
        // ignore malformed line
      }
      if (parsed.length >= MAX_RECORDS) break
    }
    records.push(...parsed)
  } catch (err) {
    console.warn('[audit-log] failed to load audit-log.jsonl:', err)
  }
}

function persist(record: AuditRecord): void {
  if (PERSIST_DISABLED) return
  try {
    if (!fssync.existsSync(DATA_DIR)) fssync.mkdirSync(DATA_DIR, { recursive: true })
    fssync.appendFileSync(FILE, JSON.stringify(record) + '\n', 'utf8')
  } catch (err) {
    // Audit logging is best-effort — never block the calling pipeline
    // on a disk error. The in-memory mirror still holds the record so
    // `queryAudit` returns the right answer until process exit.
    console.warn('[audit-log] failed to append record:', err)
  }
}

/**
 * Record a new audit event. The `id` is auto-generated; callers don't
 * supply one so there's no risk of collision.
 *
 * @returns The assigned id, so callers can correlate log lines.
 */
export function recordAudit(input: RecordAuditInput): string {
  load()
  const record: AuditRecord = {
    id: `audit-${randomUUID()}`,
    tenantId: input.tenantId ?? 'default',
    userId: input.userId ?? 'system',
    action: input.action,
    resource: input.resource,
    resourceId: input.resourceId ?? '',
    details: input.details ?? {},
    ip: input.ip ?? '0.0.0.0',
    userAgent: input.userAgent ?? 'GenOffice/1.0',
    timestamp: Date.now(),
    status: input.status ?? 'success',
  }
  // Newest first so queryAudit can `slice` without a sort pass.
  records.unshift(record)
  if (records.length > MAX_RECORDS) {
    records.length = MAX_RECORDS
  }
  persist(record)
  return record.id
}

/**
 * Query the audit log with optional filters. Results are sorted
 * newest-first and paginated with `offset` / `limit` (defaults:
 * offset=0, limit=100).
 */
export function queryAudit(filters: QueryAuditFilters = {}): {
  logs: AuditRecord[]
  total: number
} {
  load()
  const limit = filters.limit ?? 100
  const offset = filters.offset ?? 0
  let logs = records
  if (filters.userId) logs = logs.filter((l) => l.userId === filters.userId)
  if (filters.action) logs = logs.filter((l) => l.action.includes(filters.action!))
  if (filters.resource) logs = logs.filter((l) => l.resource === filters.resource)
  if (typeof filters.startDate === 'number') {
    logs = logs.filter((l) => l.timestamp >= filters.startDate!)
  }
  if (typeof filters.endDate === 'number') {
    logs = logs.filter((l) => l.timestamp <= filters.endDate!)
  }
  const total = logs.length
  return { logs: logs.slice(offset, offset + limit), total }
}

/**
 * Number of records currently held in memory. Used by tests and the
 * metrics endpoint.
 */
export function auditSize(): number {
  load()
  return records.length
}

/**
 * Read-only snapshot of all records (newest first). Kept as a
 * back-compat alias for callers that previously read `AUDIT_LOGS`
 * directly; prefer `queryAudit` for paginated reads.
 */
export function snapshotAuditLog(): AuditRecord[] {
  load()
  return records.slice()
}

/**
 * Render an export payload. The JSON / CSV branches return a string;
 * the XLSX branch returns a download URL placeholder (the actual
 * workbook generation is M5+; today we mirror the placeholder the
 * legacy `audit:export` handler emitted so downstream tests stay
 * green).
 */
export function exportAudit(opts: ExportAuditFilters = {}): {
  exportId: string
  format: 'csv' | 'json' | 'xlsx'
  recordCount: number
  body?: string
  downloadUrl?: string
} {
  let logs = records
  if (typeof opts.startDate === 'number') {
    logs = logs.filter((l) => l.timestamp >= opts.startDate!)
  }
  if (typeof opts.endDate === 'number') {
    logs = logs.filter((l) => l.timestamp <= opts.endDate!)
  }
  const format = opts.format ?? 'json'
  const exportId = `export-${randomUUID()}`
  if (format === 'json') {
    return { exportId, format, recordCount: logs.length, body: JSON.stringify(logs, null, 2) }
  }
  if (format === 'csv') {
    const header = 'id,tenantId,userId,action,resource,resourceId,timestamp,status\n'
    const rows = logs
      .map((l) =>
        [l.id, l.tenantId, l.userId, l.action, l.resource, l.resourceId, l.timestamp, l.status]
          .map((v) => {
            const s = String(v)
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(','),
      )
      .join('\n')
    return { exportId, format, recordCount: logs.length, body: header + rows + '\n' }
  }
  // xlsx placeholder — future M5: route through @genoffice/xlsx-gateway.
  return {
    exportId,
    format: 'xlsx',
    recordCount: logs.length,
    downloadUrl: `/audit/exports/${exportId}.xlsx`,
  }
}

/**
 * Test-only accessor: clear the in-memory cache and remove the on-disk
 * file. Without the file delete, the next `load()` would re-hydrate
 * the previous test's data.
 */
export function _resetAuditForTests(): void {
  records.length = 0
  loaded = false
  if (!PERSIST_DISABLED && fssync.existsSync(FILE)) {
    try {
      fssync.writeFileSync(FILE, '', 'utf8')
    } catch {
      /* best-effort */
    }
  }
}
