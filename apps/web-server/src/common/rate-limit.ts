/**
 * Per-tenant, per-endpoint token-bucket rate limiter (A17 / A59 / A60 / A61).
 *
 * Mounted by `src/index.ts` on every `/api/v1/*` route and on the legacy
 * `/api/ai/stream` SSE endpoint. A request that cannot take a token is
 * answered `429` with a `Retry-After` header (whole seconds) so a well-behaved
 * client backs off instead of retrying in a hot loop.
 *
 * Isolation is the point: the bucket key is `(tenantId, endpoint)`, so one
 * tenant draining its bucket never touches another tenant's bucket — even for
 * the same endpoint. Tenant identity comes from the JWT-derived request
 * context (`jwtPayloadFromRequest` → `tenantFromPayload` in
 * `src/auth/route-policy.ts`); a request with no verified JWT is the
 * `'default'` tenant, matching how audit records stamp provenance.
 *
 * Configuration is stored server-side as JSON under `DATA_DIR` (atomic write,
 * `common/atomic.ts`'s `atomicWriteJson`) so per-tenant tuning survives a
 * restart. The shape is:
 *
 *   {
 *     "defaults": { "capacity": 300, "refillPerSec": 30 },
 *     "tenants": {
 *       "acme": {
 *         "defaults":  { "capacity": 600 },
 *         "endpoints": { "/api/v1/ai/chat": { "capacity": 10, "refillPerSec": 0.5 } }
 *       }
 *     }
 *   }
 *
 * `defaults` is the global fallback (overridable from the
 * `GENOFFICE_RATE_LIMIT_CAPACITY` / `GENOFFICE_RATE_LIMIT_REFILL_PER_SEC` env
 * vars when the file is absent). A tenant may override the global rule
 * wholesale (`tenants[<id>].defaults`) and, on top of that, individual
 * endpoints (`tenants[<id>].endpoints[<normalized-path>]`).
 *
 * The endpoint half of the key is the request path with high-cardinality
 * dynamic segments collapsed to `:id` (see `normalizeEndpointPath`) so an
 * attacker cannot mint an unbounded number of fresh buckets by walking
 * `/api/v1/files/<uuid>`. The bucket map is additionally hard-capped so a
 * pathological path space cannot grow memory without bound.
 *
 * Everything here is single-process and synchronous — the same concurrency
 * model as `common/audit-log.ts`. A multi-process deployment would move the
 * bucket store behind a shared cache; nothing in this module pretends to be
 * cluster-safe.
 */

import * as fssync from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './state'
import { atomicWriteJson } from './atomic'

export interface RateLimitRule {
  /** Burst size: the maximum tokens a bucket holds. */
  capacity: number
  /** Sustained refill rate, tokens per second. `0` means "never refills". */
  refillPerSec: number
}

export interface RateLimitTenantConfig {
  /** Partial override merged over the global defaults for this tenant. */
  defaults?: Partial<RateLimitRule>
  /** Per-endpoint overrides, keyed by `normalizeEndpointPath(pathname)`. */
  endpoints?: Record<string, Partial<RateLimitRule>>
}

export interface RateLimitConfig {
  defaults: RateLimitRule
  tenants: Record<string, RateLimitTenantConfig>
}

export interface RateLimitDecision {
  allowed: boolean
  /** Effective capacity for the resolved rule. */
  limit: number
  /** Whole tokens still available after this check (0 when denied). */
  remaining: number
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSec: number
}

/** Persisted config file, alongside the other `DATA_DIR/*.json` stores. */
const FILE = join(DATA_DIR, 'rate-limit.json')

const DEFAULT_CAPACITY = envNumber('GENOFFICE_RATE_LIMIT_CAPACITY', 300)
const DEFAULT_REFILL_PER_SEC = envNumber('GENOFFICE_RATE_LIMIT_REFILL_PER_SEC', 30)

/**
 * Hard cap on distinct live buckets. Beyond this the oldest-inserted buckets
 * are evicted — bounded memory beats an unbounded Map fed by a hostile path
 * space. 10 000 covers every real deployment's (tenant × endpoint) matrix.
 */
const MAX_BUCKETS = 10_000

interface Bucket {
  tokens: number
  lastRefillMs: number
}

const buckets = new Map<string, Bucket>()
let configCache: RateLimitConfig | null = null

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** A finite, non-negative number, or null. Rejects NaN / Infinity / negatives. */
function validNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/** Merge a partial rule over a base rule; invalid fields leave the base intact. */
function mergeRule(base: RateLimitRule, partial: Partial<RateLimitRule> | undefined): RateLimitRule {
  if (!partial) return base
  const capacity = validNumber(partial.capacity)
  const refillPerSec = validNumber(partial.refillPerSec)
  return {
    capacity: capacity ?? base.capacity,
    refillPerSec: refillPerSec ?? base.refillPerSec,
  }
}

function sanitizeRule(raw: unknown, fallback: RateLimitRule): RateLimitRule {
  if (!raw || typeof raw !== 'object') return fallback
  return mergeRule(fallback, raw as Partial<RateLimitRule>)
}

function sanitizeTenant(raw: unknown): RateLimitTenantConfig | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { defaults?: unknown; endpoints?: unknown }
  const out: RateLimitTenantConfig = {}
  if (obj.defaults && typeof obj.defaults === 'object') {
    out.defaults = obj.defaults as Partial<RateLimitRule>
  }
  if (obj.endpoints && typeof obj.endpoints === 'object') {
    const endpoints: Record<string, Partial<RateLimitRule>> = {}
    for (const [key, value] of Object.entries(obj.endpoints as Record<string, unknown>)) {
      if (value && typeof value === 'object') endpoints[key] = value as Partial<RateLimitRule>
    }
    out.endpoints = endpoints
  }
  return out
}

/** Built-in defaults (env-overridable) used when the file omits `defaults`. */
export function builtinRateLimitDefaults(): RateLimitRule {
  return { capacity: DEFAULT_CAPACITY, refillPerSec: DEFAULT_REFILL_PER_SEC }
}

/** Read the persisted config, sanitizing every field. Never throws. */
export function loadRateLimitConfig(): RateLimitConfig {
  const fallback: RateLimitConfig = { defaults: builtinRateLimitDefaults(), tenants: {} }
  try {
    if (!fssync.existsSync(FILE)) return fallback
    const raw = JSON.parse(fssync.readFileSync(FILE, 'utf8')) as {
      defaults?: unknown
      tenants?: unknown
    }
    const tenants: Record<string, RateLimitTenantConfig> = {}
    if (raw && typeof raw === 'object' && raw.tenants && typeof raw.tenants === 'object') {
      for (const [id, value] of Object.entries(raw.tenants as Record<string, unknown>)) {
        const sanitized = sanitizeTenant(value)
        if (sanitized) tenants[id] = sanitized
      }
    }
    return {
      defaults: sanitizeRule(raw?.defaults, fallback.defaults),
      tenants,
    }
  } catch (err) {
    console.warn('[rate-limit] failed to load rate-limit.json:', err)
    return fallback
  }
}

/** Cached config accessor. Call `reloadRateLimitConfig` after an out-of-band edit. */
export function getRateLimitConfig(): RateLimitConfig {
  if (!configCache) configCache = loadRateLimitConfig()
  return configCache
}

/** Force the next `getRateLimitConfig` to re-read the file from disk. */
export function reloadRateLimitConfig(): RateLimitConfig {
  configCache = loadRateLimitConfig()
  return configCache
}

/** Replace the active config and persist it atomically. */
export function setRateLimitConfig(config: RateLimitConfig): void {
  configCache = config
  try {
    atomicWriteJson(FILE, config)
  } catch (err) {
    // Persistence is best-effort: the in-memory config still applies until
    // the process exits, and the caller should not fail on a flaky disk.
    console.warn('[rate-limit] failed to persist rate-limit.json:', err)
  }
}

/**
 * Resolve the effective rule for `(tenantId, endpoint)`:
 * global defaults → tenant defaults → tenant endpoint override.
 */
export function resolveRateLimitRule(
  tenantId: string,
  endpoint: string,
  config: RateLimitConfig = getRateLimitConfig(),
): RateLimitRule {
  let rule = config.defaults
  const tenant = config.tenants[tenantId]
  if (tenant?.defaults) rule = mergeRule(rule, tenant.defaults)
  const endpointRule = tenant?.endpoints?.[endpoint]
  if (endpointRule) rule = mergeRule(rule, endpointRule)
  return rule
}

/**
 * Collapse high-cardinality path segments to `:id` so `/api/v1/files/<uuid>`
 * and `/api/v1/files/1234` share one bucket. Segments that are long hex/dash
 * runs (UUIDs, hex ids) or all digits are considered dynamic; a short literal
 * like `/api/v1/ai/chat` is preserved verbatim.
 */
export function normalizeEndpointPath(pathname: string): string {
  const DYNAMIC = /^[0-9]+$|^[0-9a-fA-F][0-9a-fA-F-]{7,}$/
  return pathname
    .split('/')
    .map((seg) => (DYNAMIC.test(seg) ? ':id' : seg))
    .join('/')
}

/** Drop the oldest-inserted buckets once the map exceeds its cap. */
function enforceBucketCap(): void {
  if (buckets.size <= MAX_BUCKETS) return
  const excess = buckets.size - MAX_BUCKETS
  let removed = 0
  for (const key of buckets.keys()) {
    if (removed >= excess) break
    buckets.delete(key)
    removed++
  }
}

/**
 * Take one token from the `(tenantId, endpoint)` bucket, refilling first by
 * the elapsed time. Returns whether the request may proceed and, when denied,
 * how many whole seconds until at least one token is available.
 *
 * `now` is injectable so tests can advance time deterministically.
 */
export function checkRateLimit(
  tenantId: string,
  endpoint: string,
  now: number = Date.now(),
): RateLimitDecision {
  const rule = resolveRateLimitRule(tenantId, endpoint)
  const capacity = rule.capacity
  // A non-positive capacity disables limiting for this key (an explicit
  // operator opt-out), rather than denying every request.
  if (capacity <= 0) {
    return { allowed: true, limit: 0, remaining: 0, retryAfterSec: 0 }
  }

  const key = `${tenantId}\u0000${endpoint}`
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = { tokens: capacity, lastRefillMs: now }
    buckets.set(key, bucket)
    enforceBucketCap()
  } else if (rule.refillPerSec > 0 && now > bucket.lastRefillMs) {
    const elapsedSec = (now - bucket.lastRefillMs) / 1000
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * rule.refillPerSec)
    bucket.lastRefillMs = now
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return { allowed: true, limit: capacity, remaining: Math.floor(bucket.tokens), retryAfterSec: 0 }
  }

  // Denied: report when one whole token will have accrued. A zero-refill
  // bucket never recovers; report a conservative hour rather than Infinity.
  const retryAfterSec =
    rule.refillPerSec > 0 ? Math.max(1, Math.ceil((1 - bucket.tokens) / rule.refillPerSec)) : 3600
  return { allowed: false, limit: capacity, remaining: 0, retryAfterSec }
}

/** Current live bucket count. Used by tests and diagnostics. */
export function rateLimitBucketCount(): number {
  return buckets.size
}

/**
 * Test-only reset: clear every live bucket and drop the cached config so the
 * next check re-reads `rate-limit.json`. Follows the `_resetXForTests`
 * convention used by `common/audit-log.ts`.
 */
export function _resetRateLimitForTests(): void {
  buckets.clear()
  configCache = null
}
