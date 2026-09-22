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
 *
 * Metrics (sdk1 §A.5 backlog — audit log retention / rotate):
 *   `auditMetrics()` exposes four numbers via `/api/v1/metrics`:
 *     - records        in-memory ring fill
 *     - persistedBytes on-disk JSONL file size (NaN if persistence disabled)
 *     - totalRecorded  cumulative records written since process start
 *     - totalDropped   records evicted because the 10k ring overflowed
 *   Both `totalRecorded` and `totalDropped` are process-lifetime counters;
 *   a non-zero `totalDropped` is the leading indicator that the rotate /
 *   retention worker (M5+) needs to ship.
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
  /** Filter to records with `tenantId === filters.tenantId`. Empty string matches the 'default' tenant. */
  tenantId?: string
  startDate?: number
  endDate?: number
  limit?: number
  offset?: number
}

export interface ExportAuditFilters {
  format?: 'csv' | 'json' | 'xlsx'
  startDate?: number
  endDate?: number
  /** Filter to records with `tenantId === opts.tenantId`. Empty string matches the 'default' tenant. */
  tenantId?: string
}

const FILE = join(DATA_DIR, 'audit-log.jsonl')
// Default ring capacity. Mutable via `_setAuditMaxRecordsForTests` so
// overflow tests can shrink it from 10 000 to a handful without paying
// for the O(n²) unshift cost of recording 10 001 real events.
let MAX_RECORDS = 10_000
const PERSIST_DISABLED = process.env.GENOFFICE_AUDIT_PERSIST === '0'

/**
 * In-memory mirror, newest first. Bounded by `MAX_RECORDS`
 * (mutable via `_setAuditMaxRecordsForTests`).
 */
const records: AuditRecord[] = []
let loaded = false
let totalRecorded = 0
let totalDropped = 0

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
    // unshift keeps the newest, so the drop count equals the records we
    // trimmed off the tail — one drop per ring overflow entry. Counting
    // here (not at slice time) keeps the metric monotonic under concurrent
    // recordAudit calls from the save pipeline.
    totalDropped += records.length - MAX_RECORDS
    records.length = MAX_RECORDS
  }
  totalRecorded += 1
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
  if (typeof filters.tenantId === 'string') {
    const want = filters.tenantId === '' ? 'default' : filters.tenantId
    logs = logs.filter((l) => l.tenantId === want)
  }
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
 * Snapshot of every number Prometheus needs to know about the audit log.
 *
 * Exposed via `GET /api/v1/metrics` so an operator can scrape
 * `genoffice_audit_log_*` before the rotate/retention worker ships.
 * Specifically:
 *  - `records`         — current in-memory ring fill; saturated at 10 000.
 *  - `persistedBytes`  — current `audit-log.jsonl` size on disk; `null`
 *    when persistence is disabled (GENOFFICE_AUDIT_PERSIST=0) or the
 *    file has not been created yet (no recordAudit call).
 *  - `totalRecorded`   — lifetime counter; monotonically increasing.
 *  - `totalDropped`    — lifetime counter for ring overflow events.
 *
 * All four fields are read in O(1); no fs I/O happens for `records`,
 * `totalRecorded`, or `totalDropped`. `persistedBytes` is a single
 * `statSync` against the JSONL file, cheap enough for a per-scrape
 * Prometheus call (every 15-60 s in normal deployments).
 */
export function auditMetrics(): {
  records: number
  persistedBytes: number | null
  totalRecorded: number
  totalDropped: number
} {
  load()
  let persistedBytes: number | null = null
  if (!PERSIST_DISABLED && fssync.existsSync(FILE)) {
    try {
      persistedBytes = fssync.statSync(FILE).size
    } catch {
      // statSync can fail on a concurrently-rotated file (M5+ rotate
      // worker). Treat as unknown rather than throwing through the
      // metrics endpoint.
      persistedBytes = null
    }
  }
  return {
    records: records.length,
    persistedBytes,
    totalRecorded,
    totalDropped,
  }
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
  if (typeof opts.tenantId === 'string') {
    const want = opts.tenantId === '' ? 'default' : opts.tenantId
    logs = logs.filter((l) => l.tenantId === want)
  }
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
/**
 * Override the in-memory ring cap (test-only). Returns the previous
 * value so the caller can restore it. Production code never calls this;
 * it's exported to keep the overflow test cheap — recording 10 001
 * real events would be O(n²) under the current unshift-on-the-front
 * layout, which is fine in production but punishing in a vitest run.
 */
/**
 * Retention / rotate worker (sdk1 §A.5 audit-log backlog close).
 *
 * Default: trim audit-log.jsonl to those with `timestamp` newer than
 * `GENOFFICE_AUDIT_RETENTION_DAYS` (default 90). The rotate is a
 * streaming rewrite — it filters the on-disk JSONL line-by-line,
 * atomically swaps the file via temp + rename, and updates
 * `totalDropped` on the metrics surface so Prometheus scrapes show
 * the eviction immediately.
 *
 * Background loop:
 * - `startAuditRotateWorker()` registers a `setInterval` that calls
 *   `rotateAuditLog()` once every `GENOFFICE_AUDIT_ROTATE_INTERVAL_MS`
 *   (default 24h).
 * - `_stopAuditRotateWorkerForTests()` clears the interval; production
 *   code never calls this. The interval is `unref()`'d so it never
 *   holds the event loop open on shutdown.
 */
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h

let rotateTimer: NodeJS.Timeout | null = null

export interface RotateResult {
  /** Number of records retained in the rewritten file. */
  kept: number
  /** Number of records evicted because their timestamp predates the cutoff. */
  dropped: number
  /** ISO 8601 cutoff used for this rotation (records older than this are dropped). */
  cutoffIso: string
  /** True if the JSONL file did not exist (no-op rotation). */
  skipped: boolean
}

/** Compute the retention cutoff timestamp in ms for "now - retentionDays".
 *  Visible for tests; production code calls `rotateAuditLog()`. */
export function retentionCutoffMs(now: number = Date.now(), retentionDays: number = retentionDaysFromEnv()): number {
  return now - retentionDays * 24 * 60 * 60 * 1000
}

function retentionDaysFromEnv(): number {
  const raw = process.env.GENOFFICE_AUDIT_RETENTION_DAYS
  if (!raw) return DEFAULT_RETENTION_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

function rotateIntervalMsFromEnv(): number {
  const raw = process.env.GENOFFICE_AUDIT_ROTATE_INTERVAL_MS
  if (!raw) return DEFAULT_ROTATE_INTERVAL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_ROTATE_INTERVAL_MS
}

/**
 * Run one rotation pass: read every line, keep records with
 * `timestamp >= cutoffMs`, atomically swap the JSONL file, and bump
 * `totalDropped` accordingly. Returns the kept / dropped counts.
 *
 * Idempotent: calling repeatedly with the same cutoff is a no-op
 * once the file already matches the retention window. Never throws
 * — failures are logged and reported via the `skipped` flag.
 */
export function rotateAuditLog(opts: { retentionDays?: number; nowMs?: number } = {}): RotateResult {
  const retentionDays = opts.retentionDays ?? retentionDaysFromEnv()
  const nowMs = opts.nowMs ?? Date.now()
  const cutoffMs = retentionCutoffMs(nowMs, retentionDays)
  if (PERSIST_DISABLED || !fssync.existsSync(FILE)) {
    return { kept: 0, dropped: 0, cutoffIso: new Date(cutoffMs).toISOString(), skipped: true }
  }
  let raw: string
  try {
    raw = fssync.readFileSync(FILE, 'utf8')
  } catch (err) {
    console.warn('[audit-log] rotate: failed to read file:', err)
    return { kept: 0, dropped: 0, cutoffIso: new Date(cutoffMs).toISOString(), skipped: true }
  }
  if (!raw.trim()) {
    return { kept: 0, dropped: 0, cutoffIso: new Date(cutoffMs).toISOString(), skipped: false }
  }
  const lines = raw.split('\n')
  const keptLines: string[] = []
  let dropped = 0
  let kept = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: AuditRecord
    try {
      rec = JSON.parse(trimmed) as AuditRecord
    } catch {
      // Malformed: drop it (a corrupted line is "older than anything").
      dropped++
      continue
    }
    if (typeof rec.timestamp !== 'number' || rec.timestamp < cutoffMs) {
      dropped++
      continue
    }
    keptLines.push(trimmed)
    kept++
  }
  if (dropped === 0) {
    // No work to do — don't touch the file or the metrics counters.
    return { kept, dropped, cutoffIso: new Date(cutoffMs).toISOString(), skipped: false }
  }
  try {
    const tmp = `${FILE}.rotate-${process.pid}-${Date.now()}.tmp`
    fssync.writeFileSync(tmp, keptLines.join('\n') + (keptLines.length ? '\n' : ''), 'utf8')
    fssync.renameSync(tmp, FILE)
    totalDropped += dropped
  } catch (err) {
    console.warn('[audit-log] rotate: failed to swap file:', err)
    return { kept, dropped, cutoffIso: new Date(cutoffMs).toISOString(), skipped: true }
  }
  return { kept, dropped, cutoffIso: new Date(cutoffMs).toISOString(), skipped: false }
}

/**
 * Start the background retention loop. Idempotent: calling twice is
 * a no-op (the second call returns the existing timer). The timer is
 * `unref()`'d so a server that calls this can still exit cleanly when
 * its other work drains — the rotate is best-effort housekeeping,
 * not a critical task.
 *
 * Returns the timer handle so callers (tests) can inspect / cancel.
 */
export function startAuditRotateWorker(): NodeJS.Timeout | null {
  if (rotateTimer) return rotateTimer
  const intervalMs = rotateIntervalMsFromEnv()
  rotateTimer = setInterval(() => {
    try {
      const r = rotateAuditLog()
      if (r.dropped > 0) {
        console.log(
          `[audit-log] rotated: kept=${r.kept} dropped=${r.dropped} cutoff=${r.cutoffIso}`,
        )
      }
    } catch (err) {
      console.warn('[audit-log] rotate worker tick failed:', err)
    }
  }, intervalMs)
  rotateTimer.unref?.()
  return rotateTimer
}

/** Cancel the background retention loop. Test-only — production code
 *  never calls this; the worker keeps running for the process lifetime. */
export function _stopAuditRotateWorkerForTests(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = null
  }
}

export function _setAuditMaxRecordsForTests(max: number): number {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`_setAuditMaxRecordsForTests: max must be ≥ 1, got ${max}`)
  }
  const prev = MAX_RECORDS
  MAX_RECORDS = max
  // If the caller shrank the cap below the current fill, drop the tail
  // so the next auditMetrics() / auditSize() call sees the new cap.
  if (records.length > MAX_RECORDS) {
    totalDropped += records.length - MAX_RECORDS
    records.length = MAX_RECORDS
  }
  return prev
}

export function _resetAuditForTests(): void {
  records.length = 0
  loaded = false
  totalRecorded = 0
  totalDropped = 0
  if (!PERSIST_DISABLED && fssync.existsSync(FILE)) {
    try {
      fssync.writeFileSync(FILE, '', 'utf8')
    } catch {
      /* best-effort */
    }
  }
}
