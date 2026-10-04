/**
 * Disk-backed AI usage meter (A18 / A22 / A62 / A63).
 *
 * One record per AI call — provider, model, prompt/completion tokens,
 * latency, tenant, endpoint, timestamp. The token fields stay `undefined`
 * when the call path genuinely cannot surface them (a batch translate runs
 * inside the core worker pool, an image fetch is not a model turn); we never
 * invent counts. This is the metering twin of `common/audit-log.ts` and
 * follows the same conventions:
 *
 *   - append-only JSONL at `DATA_DIR/usage-meter.jsonl`, one record per line;
 *   - a bounded in-memory mirror (newest 10 000) so `aggregateUsage` and
 *     `queryUsage` never re-read the file;
 *   - best-effort persistence — a disk failure logs a warning and never
 *     throws, so a flaky disk cannot stall the AI pipeline;
 *   - a time-based `rotateUsageLog` (default 90 days) that atomically swaps
 *     the file via temp + rename.
 *
 * Set `GENOFFICE_USAGE_PERSIST=0` to disable persistence (tests that don't
 * want disk writes to escape their TMP DATA_DIR).
 *
 * Unlike the audit log, this store is queried through the v1 surface
 * (`GET /api/v1/ai/usage`) which reads `aggregateUsage` directly; the record
 * shape is intentionally flat so `jq`, `tail -f`, and cost-reporting export
 * jobs can consume it without a custom parser.
 */

// Namespace import so `vi.mock('node:fs')` can intercept the binding.
import * as fssync from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DATA_DIR } from './state'

export interface UsageRecord {
  id: string
  tenantId: string
  /** Route or IPC channel that carried the call (`/api/ai/stream`, `ai:translate`, …). */
  endpoint: string
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  timestamp: number
}

export interface RecordUsageInput {
  tenantId?: string
  endpoint: string
  provider?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  latencyMs?: number
  /** Override the stamped timestamp (tests); defaults to `Date.now()`. */
  timestamp?: number
}

export interface QueryUsageFilters {
  tenantId?: string
  endpoint?: string
  fromMs?: number
  toMs?: number
  limit?: number
  offset?: number
}

export interface TenantUsageAggregate {
  tenantId: string
  calls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** Mean latency over records that carried one; null when none did. */
  avgLatencyMs: number | null
}

export interface UsageAggregateResult {
  from: number
  to: number
  tenants: TenantUsageAggregate[]
  totals: {
    calls: number
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

const FILE = join(DATA_DIR, 'usage-meter.jsonl')
let MAX_RECORDS = 10_000
const PERSIST_DISABLED = process.env.GENOFFICE_USAGE_PERSIST === '0'

/** In-memory mirror, newest first, bounded by `MAX_RECORDS`. */
const records: UsageRecord[] = []
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
    const parsed: UsageRecord[] = []
    // Iterate from the end so the mirror stays newest-first without a sort.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try {
        const rec = JSON.parse(line) as UsageRecord
        if (rec && typeof rec === 'object' && typeof rec.id === 'string') parsed.push(rec)
        // A partial tail from `kill -9` is normal for a log file — skip it.
      } catch {
        /* ignore malformed line */
      }
      if (parsed.length >= MAX_RECORDS) break
    }
    records.push(...parsed)
  } catch (err) {
    console.warn('[usage-meter] failed to load usage-meter.jsonl:', err)
  }
}

function persist(record: UsageRecord): void {
  if (PERSIST_DISABLED) return
  try {
    if (!fssync.existsSync(DATA_DIR)) fssync.mkdirSync(DATA_DIR, { recursive: true })
    fssync.appendFileSync(FILE, JSON.stringify(record) + '\n', 'utf8')
  } catch (err) {
    // Best-effort: the in-memory mirror still answers queries until exit.
    console.warn('[usage-meter] failed to append record:', err)
  }
}

/**
 * Record one AI call. Only the fields a caller actually knows are written;
 * absent token/provider/model values stay absent rather than defaulting to 0
 * or a placeholder, so a genuine "unknown" is distinguishable from a real zero.
 *
 * @returns The assigned record id.
 */
export function recordUsage(input: RecordUsageInput): string {
  load()
  const record: UsageRecord = {
    id: `usage-${randomUUID()}`,
    tenantId: input.tenantId?.trim() || 'default',
    endpoint: input.endpoint,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(typeof input.promptTokens === 'number' ? { promptTokens: input.promptTokens } : {}),
    ...(typeof input.completionTokens === 'number' ? { completionTokens: input.completionTokens } : {}),
    ...(typeof input.totalTokens === 'number' ? { totalTokens: input.totalTokens } : {}),
    ...(typeof input.latencyMs === 'number' ? { latencyMs: input.latencyMs } : {}),
    timestamp: input.timestamp ?? Date.now(),
  }
  records.unshift(record)
  if (records.length > MAX_RECORDS) {
    totalDropped += records.length - MAX_RECORDS
    records.length = MAX_RECORDS
  }
  totalRecorded += 1
  persist(record)
  return record.id
}

/** Query raw usage records, newest first. */
export function queryUsage(filters: QueryUsageFilters = {}): {
  records: UsageRecord[]
  total: number
} {
  load()
  const limit = filters.limit ?? 100
  const offset = filters.offset ?? 0
  let rows = records
  if (typeof filters.tenantId === 'string') {
    const want = filters.tenantId === '' ? 'default' : filters.tenantId
    rows = rows.filter((r) => r.tenantId === want)
  }
  if (filters.endpoint) rows = rows.filter((r) => r.endpoint === filters.endpoint)
  if (typeof filters.fromMs === 'number') rows = rows.filter((r) => r.timestamp >= filters.fromMs!)
  if (typeof filters.toMs === 'number') rows = rows.filter((r) => r.timestamp <= filters.toMs!)
  const total = rows.length
  return { records: rows.slice(offset, offset + limit), total }
}

/**
 * Aggregate usage per tenant within `[fromMs, toMs]`. When `tenantId` is set
 * only that tenant is aggregated (used by the non-operator query path in
 * `api/v1/ai.ts`); omitted, every tenant in the window is returned.
 *
 * A missing token count contributes 0 to the sum — the aggregate is a total,
 * not a completeness statement. `avgLatencyMs` only averages records that
 * carried a latency so an untimed call doesn't drag the mean toward zero.
 */
export function aggregateUsage(
  opts: { fromMs?: number; toMs?: number; tenantId?: string } = {},
): UsageAggregateResult {
  load()
  const from = opts.fromMs ?? 0
  const to = opts.toMs ?? Number.MAX_SAFE_INTEGER
  const wantTenant = opts.tenantId
  const byTenant = new Map<string, TenantUsageAggregate & { latencySum: number; latencyCount: number }>()
  let promptTokens = 0
  let completionTokens = 0
  let totalTokens = 0
  let calls = 0
  for (const rec of records) {
    if (rec.timestamp < from || rec.timestamp > to) continue
    if (wantTenant !== undefined && rec.tenantId !== wantTenant) continue
    calls++
    promptTokens += rec.promptTokens ?? 0
    completionTokens += rec.completionTokens ?? 0
    totalTokens += rec.totalTokens ?? 0
    let agg = byTenant.get(rec.tenantId)
    if (!agg) {
      agg = {
        tenantId: rec.tenantId,
        calls: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        avgLatencyMs: null,
        latencySum: 0,
        latencyCount: 0,
      }
      byTenant.set(rec.tenantId, agg)
    }
    agg.calls++
    agg.promptTokens += rec.promptTokens ?? 0
    agg.completionTokens += rec.completionTokens ?? 0
    agg.totalTokens += rec.totalTokens ?? 0
    if (typeof rec.latencyMs === 'number') {
      agg.latencySum += rec.latencyMs
      agg.latencyCount++
    }
  }
  const tenants: TenantUsageAggregate[] = [...byTenant.values()]
    .map(({ latencySum, latencyCount, ...rest }) => ({
      ...rest,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
    }))
    // Stable, alphabetical so the response is deterministic across runs.
    .sort((a, b) => a.tenantId.localeCompare(b.tenantId))
  return { from, to, tenants, totals: { calls, promptTokens, completionTokens, totalTokens } }
}

/** Number of records currently held in memory (tests + diagnostics). */
export function usageSize(): number {
  load()
  return records.length
}

/** Immutable snapshot of every in-memory record, newest first. */
export function snapshotUsage(): UsageRecord[] {
  load()
  return records.slice()
}

/** Lifetime counters + ring fill, for a Prometheus-style scrape. */
export function usageMetrics(): {
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

const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_ROTATE_INTERVAL_MS = 24 * 60 * 60 * 1000
let rotateTimer: NodeJS.Timeout | null = null

export interface UsageRotateResult {
  kept: number
  dropped: number
  cutoffIso: string
  skipped: boolean
}

function retentionDaysFromEnv(): number {
  const raw = process.env.GENOFFICE_USAGE_RETENTION_DAYS
  if (!raw) return DEFAULT_RETENTION_DAYS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS
}

function rotateIntervalMsFromEnv(): number {
  const raw = process.env.GENOFFICE_USAGE_ROTATE_INTERVAL_MS
  if (!raw) return DEFAULT_ROTATE_INTERVAL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_ROTATE_INTERVAL_MS
}

/**
 * Drop records older than the retention window from the JSONL file, atomically
 * swapping it via temp + rename. Idempotent and never throws — failures are
 * reported through `skipped`.
 */
export function rotateUsageLog(
  opts: { retentionDays?: number; nowMs?: number } = {},
): UsageRotateResult {
  const retentionDays = opts.retentionDays ?? retentionDaysFromEnv()
  const nowMs = opts.nowMs ?? Date.now()
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000
  const cutoffIso = new Date(cutoffMs).toISOString()
  if (PERSIST_DISABLED || !fssync.existsSync(FILE)) {
    return { kept: 0, dropped: 0, cutoffIso, skipped: true }
  }
  let raw: string
  try {
    raw = fssync.readFileSync(FILE, 'utf8')
  } catch (err) {
    console.warn('[usage-meter] rotate: failed to read file:', err)
    return { kept: 0, dropped: 0, cutoffIso, skipped: true }
  }
  if (!raw.trim()) return { kept: 0, dropped: 0, cutoffIso, skipped: false }
  const keptLines: string[] = []
  let kept = 0
  let dropped = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let rec: UsageRecord
    try {
      rec = JSON.parse(trimmed) as UsageRecord
    } catch {
      // A corrupted line is "older than anything" — drop it.
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
  if (dropped === 0) return { kept, dropped, cutoffIso, skipped: false }
  try {
    const tmp = `${FILE}.rotate-${process.pid}-${Date.now()}.tmp`
    fssync.writeFileSync(tmp, keptLines.join('\n') + (keptLines.length ? '\n' : ''), 'utf8')
    fssync.renameSync(tmp, FILE)
    totalDropped += dropped
  } catch (err) {
    console.warn('[usage-meter] rotate: failed to swap file:', err)
    return { kept, dropped, cutoffIso, skipped: true }
  }
  return { kept, dropped, cutoffIso, skipped: false }
}

/** Start the background retention loop (idempotent, unref'd). */
export function startUsageRotateWorker(): NodeJS.Timeout | null {
  if (rotateTimer) return rotateTimer
  rotateTimer = setInterval(() => {
    try {
      const r = rotateUsageLog()
      if (r.dropped > 0) {
        console.log(`[usage-meter] rotated: kept=${r.kept} dropped=${r.dropped} cutoff=${r.cutoffIso}`)
      }
    } catch (err) {
      console.warn('[usage-meter] rotate worker tick failed:', err)
    }
  }, rotateIntervalMsFromEnv())
  rotateTimer.unref?.()
  return rotateTimer
}

/** Cancel the background retention loop. Test-only. */
export function _stopUsageRotateWorkerForTests(): void {
  if (rotateTimer) {
    clearInterval(rotateTimer)
    rotateTimer = null
  }
}

/**
 * Override the in-memory ring cap (test-only). Returns the previous value so
 * the caller can restore it; production never calls this.
 */
export function _setUsageMaxRecordsForTests(max: number): number {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`_setUsageMaxRecordsForTests: max must be >= 1, got ${max}`)
  }
  const prev = MAX_RECORDS
  MAX_RECORDS = max
  if (records.length > MAX_RECORDS) {
    totalDropped += records.length - MAX_RECORDS
    records.length = MAX_RECORDS
  }
  return prev
}

/**
 * Test-only reset: clear the mirror and counters, and truncate the on-disk
 * file so the next `load()` does not re-hydrate the previous test's data.
 */
export function _resetUsageForTests(): void {
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
