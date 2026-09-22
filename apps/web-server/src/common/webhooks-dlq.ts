/**
 * Dead-letter queue for failed webhook deliveries (sdk1.md §11.33).
 *
 * `fireCallback()` retries up to `maxAttempts` with exponential backoff.
 * When all attempts fail OR the response is a non-retryable 4xx, the
 * delivery is dropped on the floor with only a `console.warn` — the save
 * pipeline stays unblocked, but the host integrator has no way to know
 * which events were lost.
 *
 * The DLQ closes that gap: every dropped delivery is also written here
 * (process-local ring buffer, LRU capped at 1024 entries) with the
 * serialized body, status history, and the timestamp it was dropped.
 * Hosts can then:
 *
 *   - `list dlq entries`  →  GET  /api/v1/webhooks/dlq
 *   - `get one entry`     →  GET  /api/v1/webhooks/dlq/:id
 *   - `replay one entry`  →  POST /api/v1/webhooks/dlq/:id/replay
 *     (one-shot replay; on success the entry is removed, on failure it
 *     stays with `lastError` updated)
 *   - `drop one entry`    →  DELETE /api/v1/webhooks/dlq/:id
 *
 * Durability (sdk1.md §11.33.4 / §11.35.4 backlog, closed): the DLQ is
 * now disk-backed. Every mutation (add / update / remove / clear) writes
 * the queue atomically to `DATA_DIR/webhooks-dlq.json`; the file is
 * loaded at module init so a server restart preserves dropped
 * deliveries. This is the same storage model as `webhooks.json`
 * (`common/webhooks-store.ts`) and `version-history.ts` — a single JSON
 * document under `DATA_DIR`, no external dependency (Redis / Postgres
 * would be overkill for a queue capped at 1024 entries).
 *
 * Set `GENOFFICE_DLQ_PERSIST=0` to disable persistence (used by tests
 * that don't want disk writes to escape their TMP DATA_DIR; the load
 * path is skipped too so a stale file can't leak in).
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic'
import { DATA_DIR } from './state'
import { fireCallback, type WebhookDeliveryOptions } from './webhooks-store'

export interface DeadLetterEntry {
  /** Stable identifier for API reference. URL-safe base64 of 8 random bytes. */
  id: string
  /** Target URL the delivery was bound to. */
  url: string
  /** Event name (e.g. 'file.saved'). */
  event: string
  /** File id from the originating save path. */
  fileId: string
  /** Serialized webhook body (signed once at drop time; re-signed on replay). */
  body: string
  /** Number of delivery attempts already spent before this entry was dropped. */
  attempts: number
  /** Final HTTP status, or null if every attempt errored before getting a response. */
  lastStatus: number | null
  /** Most recent error message, if any. */
  lastError: string | null
  /** Reason this entry was dropped (so hosts can branch in tooling). */
  reason: 'max_attempts' | 'non_retryable_4xx'
  /** Epoch milliseconds (UTC) when the entry was created. */
  droppedAt: number
}

export interface DeadLetterStore {
  /** Number of entries currently held. */
  size(): number
  /** Insert a new entry. Returns the assigned id. */
  add(entry: Omit<DeadLetterEntry, 'id' | 'droppedAt'>): string
  /** Get a single entry by id. */
  get(id: string): DeadLetterEntry | null
  /** List entries, newest first. `limit` caps the returned slice (default 50). */
  list(opts?: { limit?: number }): DeadLetterEntry[]
  /** Update an entry in place. Returns true on success, false if the id is unknown. */
  update(id: string, patch: Partial<Omit<DeadLetterEntry, 'id'>>): boolean
  /** Remove an entry. Returns true if removed, false if the id was unknown. */
  remove(id: string): boolean
  /** Drop all entries. Used by tests and the (optional) admin reset path. */
  clear(): void
}

const MAX_ENTRIES = 1024
const RANDOM_BYTE_LEN = 8

/**
 * Process-local counters surfaced through `getDeadLetterMetrics()`. We
 * track totals across the whole lifetime so /metrics has monotonic
 * values for Prometheus to rate() against; size is exposed separately
 * because it can drop (eviction / manual delete) without the totals
 * changing.
 *
 * Restart clears both — same durability model as the DLQ itself.
 */
const totals = {
  dropped: 0,
  replayed: 0,
  /** Counts broken down by the reason field recorded at push time. */
  byReason: { max_attempts: 0, non_retryable_4xx: 0 } as Record<'max_attempts' | 'non_retryable_4xx', number>,
}

function makeId(): string {
  // URL-safe base64 of 8 random bytes → 11 chars. crypto.getRandomValues is
  // available in both Node 22 and modern browsers.
  const bytes = new Uint8Array(RANDOM_BYTE_LEN)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    // Best-effort fallback for environments without crypto; uniqueness is
    // not security-critical here (the id is a lookup key, not a secret).
    for (let i = 0; i < RANDOM_BYTE_LEN; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  // Node Buffer is available in this codebase (Node-only module).
  return Buffer.from(bin, 'binary').toString('base64url')
}

const DLQ_FILE = join(DATA_DIR, 'webhooks-dlq.json')

/** Persistence is on by default; tests can opt out via GENOFFICE_DLQ_PERSIST=0. */
function persistenceEnabled(): boolean {
  return process.env.GENOFFICE_DLQ_PERSIST !== '0'
}

/** Shape written to disk. Bump `version` if the schema ever changes. */
interface DlqFileShape {
  version: 1
  entries: DeadLetterEntry[]
}

function readFromDisk(): DeadLetterEntry[] {
  if (!persistenceEnabled()) return []
  try {
    if (!existsSync(DLQ_FILE)) return []
    const parsed = JSON.parse(readFileSync(DLQ_FILE, 'utf8')) as DlqFileShape
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) return []
    // Defensive filter: a hand-edited or partially-written file must not
    // inject malformed entries that later crash the DLQ consumers.
    return parsed.entries.filter(
      (e): e is DeadLetterEntry =>
        !!e &&
        typeof e.id === 'string' &&
        typeof e.url === 'string' &&
        typeof e.event === 'string' &&
        typeof e.body === 'string' &&
        typeof e.droppedAt === 'number' &&
        (e.reason === 'max_attempts' || e.reason === 'non_retryable_4xx'),
    )
  } catch {
    // A corrupt file should not brick the server — log + start empty. The
    // previous file (if any) stays on disk for manual recovery.
    return []
  }
}

function writeToDisk(entries: Map<string, DeadLetterEntry>): void {
  if (!persistenceEnabled()) return
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const doc: DlqFileShape = { version: 1, entries: Array.from(entries.values()) }
    atomicWriteJson(DLQ_FILE, doc)
  } catch {
    // Persistence is best-effort — a disk-full condition must not break the
    // save pipeline that pushes to the DLQ. The in-memory copy stays
    // authoritative for the running process; the next successful write
    // brings the file back in sync.
  }
}

const store: DeadLetterStore = (() => {
  const entries = new Map<string, DeadLetterEntry>()
  // Hydrate from disk at module init. Insertion order matches the file's
  // array order, so `list()` (reverse insertion) keeps newest-first.
  for (const e of readFromDisk()) entries.set(e.id, e)
  return {
    size: () => entries.size,
    add(entry) {
      const id = makeId()
      entries.set(id, { ...entry, id, droppedAt: Date.now() })
      // LRU eviction: the oldest-inserted entry (per Map iteration order)
      // is dropped once we cross the cap. We use insertion order rather
      // than access order because DLQ entries are immutable after insert
      // — replay doesn't touch `droppedAt`, so the only operation that
      // would re-order is `remove`.
      while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        entries.delete(oldest)
      }
      writeToDisk(entries)
      return id
    },
    get: (id) => entries.get(id) ?? null,
    list({ limit } = {}) {
      const cap = Math.max(1, Math.min(limit ?? 50, MAX_ENTRIES))
      const out: DeadLetterEntry[] = []
      // newest first → iterate the map in reverse insertion order.
      const ids = Array.from(entries.keys()).reverse()
      for (const id of ids) {
        const e = entries.get(id)
        if (!e) continue
        out.push(e)
        if (out.length >= cap) break
      }
      return out
    },
    update(id, patch) {
      const existing = entries.get(id)
      if (!existing) return false
      entries.set(id, { ...existing, ...patch, id, droppedAt: existing.droppedAt })
      writeToDisk(entries)
      return true
    },
    remove(id) {
      const removed = entries.delete(id)
      if (removed) writeToDisk(entries)
      return removed
    },
    clear() {
      entries.clear()
      writeToDisk(entries)
    },
  }
})()

/** Internal — only `webhooks-store.fireCallback()` should call this. */
export function pushDeadLetter(entry: Omit<DeadLetterEntry, 'id' | 'droppedAt'>): string {
  const id = store.add(entry)
  // Bump lifetime counters here (not inside store.add) so external
  // callers that bypass the wrapper — currently none, but the store
  // interface is part of the module's contract — never silently
  // drift out of metrics parity. evictions drop `size` but NOT
  // `totalDropped`; the counter is monotonic for Prometheus rate().
  totals.dropped += 1
  totals.byReason[entry.reason] += 1
  return id
}

/** Public read API for v1 endpoint. */
export function listDeadLetters(opts?: { limit?: number }): DeadLetterEntry[] {
  return store.list(opts)
}

/** Public read API for v1 endpoint. */
export function getDeadLetter(id: string): DeadLetterEntry | null {
  return store.get(id)
}

/** Public mutation API for v1 endpoint (acknowledge / drop). */
export function deleteDeadLetter(id: string): boolean {
  return store.remove(id)
}

/**
 * Snapshot of DLQ counters + per-reason breakdown. Returned shape is
 * stable so v1 /metrics can serialize to JSON or Prometheus text.
 *
 * `oldestDroppedAt` / `newestDroppedAt` are epoch ms; either may be
 * `null` when the queue is empty (which a Prometheus exporter can
 * translate into NaN / omitted sample).
 */
export interface DeadLetterMetrics {
  /** Current number of entries held in the ring buffer. */
  size: number
  /** Cumulative entries pushed since process start. Monotonic. */
  totalDropped: number
  /** Cumulative successful replays since process start. Monotonic. */
  totalReplayed: number
  /** Drop counts broken down by reason field. */
  byReason: { max_attempts: number; non_retryable_4xx: number }
  /** Epoch ms of the oldest entry still in the buffer (null when empty). */
  oldestDroppedAt: number | null
  /** Epoch ms of the newest entry still in the buffer (null when empty). */
  newestDroppedAt: number | null
}

export function getDeadLetterMetrics(): DeadLetterMetrics {
  let oldest: number | null = null
  let newest: number | null = null
  for (const e of store.list({ limit: MAX_ENTRIES })) {
    if (oldest === null || e.droppedAt < oldest) oldest = e.droppedAt
    if (newest === null || e.droppedAt > newest) newest = e.droppedAt
  }
  return {
    size: store.size(),
    totalDropped: totals.dropped,
    totalReplayed: totals.replayed,
    byReason: {
      max_attempts: totals.byReason.max_attempts,
      non_retryable_4xx: totals.byReason.non_retryable_4xx,
    },
    oldestDroppedAt: oldest,
    newestDroppedAt: newest,
  }
}

/** Test-only accessor so vitest can reset totals between cases. */
export function _resetDeadLetterMetricsForTests(): void {
  totals.dropped = 0
  totals.replayed = 0
  totals.byReason.max_attempts = 0
  totals.byReason.non_retryable_4xx = 0
}

/**
 * Replay one DLQ entry — single attempt, no retries. On success the
 * entry is removed from the DLQ; on failure it stays with `lastError`
 * and `attempts` updated so the operator can see the new failure.
 *
 * Returns the fresh delivery result alongside the (possibly removed) DLQ
 * entry. The function is intentionally synchronous in shape — the caller
 * awaits a single Promise that resolves once the replay attempt has
 * either succeeded or definitively failed.
 */
export async function replayDeadLetter(
  id: string,
  opts: WebhookDeliveryOptions = {},
): Promise<
  | { ok: true; removed: true; result: { finalStatus: number | null; attempts: number; delivered: boolean } }
  | { ok: true; removed: false; entry: DeadLetterEntry; result: { finalStatus: number | null; attempts: number; delivered: boolean; lastError?: string } }
  | { ok: false; reason: 'unknown_id' }
> {
  const entry = store.get(id)
  if (!entry) return { ok: false, reason: 'unknown_id' }
  // Single-shot delivery: maxAttempts=1, no jitter wait between attempts.
  // We bypass `fireCallback()` here because that function regenerates the
  // body and signature from the registered callback — instead we post the
  // exact body that was dropped, preserving the original timestamp so the
  // receiver's idempotency keys still match.
  const result = await postOnce(entry.url, entry.body, opts)
  if (result.delivered) {
    store.remove(id)
    // Count only successful replays — failed replays stay in the
    // DLQ with updated lastError and the counter doesn't move.
    totals.replayed += 1
    return {
      ok: true,
      removed: true,
      result: { finalStatus: result.finalStatus, attempts: result.attempts, delivered: true },
    }
  }
  // Update the entry in place so the id stays stable across replays —
  // hosts can track the same entry across retry cycles. `attempts` is
  // cumulative (original + replay attempts); lastStatus / lastError
  // reflect the most recent failure.
  store.update(id, {
    attempts: entry.attempts + result.attempts,
    lastStatus: result.finalStatus,
    lastError: result.lastError ?? entry.lastError,
  })
  const updated = store.get(id)!
  return {
    ok: true,
    removed: false,
    entry: updated,
    result: {
      finalStatus: result.finalStatus,
      attempts: result.attempts,
      delivered: false,
      ...(result.lastError ? { lastError: result.lastError } : {}),
    },
  }
}

async function postOnce(
  url: string,
  body: string,
  opts: WebhookDeliveryOptions,
): Promise<{ finalStatus: number | null; attempts: number; delivered: boolean; lastError?: string }> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 1)
  const initialBackoffMs = Math.max(0, opts.initialBackoffMs ?? 0)
  let lastError: string | undefined
  let lastStatus: number | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        return { finalStatus: res.status, attempts: attempt, delivered: true }
      }
      lastStatus = res.status
      const retryable = res.status >= 500 || res.status === 429
      if (!retryable) {
        return { finalStatus: res.status, attempts: attempt, delivered: false }
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
    if (attempt < maxAttempts) {
      const base = initialBackoffMs * 2 ** (attempt - 1)
      const capped = Math.min(base, 8_000)
      const jitter = Math.floor(Math.random() * capped)
      await new Promise((res) => setTimeout(res, jitter))
    }
  }
  return {
    finalStatus: lastStatus,
    attempts: maxAttempts,
    delivered: false,
    ...(lastError ? { lastError } : {}),
  }
}

/** Test-only accessor so vitest can reset the DLQ between cases. */
export function _resetDeadLetterForTests(): void {
  store.clear()
  _resetDeadLetterMetricsForTests()
}
