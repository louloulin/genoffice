/**
 * Per-request retry + registry failover policy for streaming provider calls.
 *
 * Both features reuse the existing error taxonomy in this package:
 *  - `AiTimeoutError` (watchdog) → errorCode 'timeout'
 *  - `isAiNetworkError` (network-error) → errorCode 'network'
 *  - `isAiOverloadedError` (overload-error) → errorCode 'overloaded'
 *  - `isAiQuotaExhaustedError` / `AiCreditsError` → errorCode 'credits' (never retryable)
 *
 * The classifier also honours an explicit `errorCode` property when a thrown
 * error already carries one from the `'timeout' | 'credits' | 'network' |
 * 'overloaded'` union in ./types so a caller can fault-inject a typed failure.
 */

import type { AiProviderConfig, AiProviderId } from './types'
import { isAiNetworkError } from './network-error'
import { isAiOverloadedError, isAiQuotaExhaustedError } from './overload-error'
import { AiCreditsError } from './protocols/shared'
import { AiTimeoutError } from './watchdog'

/** The subset of the ai-provider error taxonomy this module reasons about. */
export type ProviderErrorClass = 'timeout' | 'network' | 'overloaded' | 'credits' | 'other'

/** Retry budget for one provider before it is considered failed. */
export interface AiRetryPolicy {
  /** Retries AFTER the first attempt (default {@link DEFAULT_MAX_RETRIES}). */
  maxRetries?: number
  /** Base of the exponential-backoff curve, in ms (default {@link DEFAULT_RETRY_BASE_DELAY_MS}). */
  baseDelayMs?: number
}

/** Observability payload emitted on every failover switch, for an audit record. */
export interface ProviderSwitchInfo {
  from: AiProviderId
  to: AiProviderId
  /** 1-based index of the switch in the failover sequence. */
  attempt: number
  /** Classified reason the previous provider was abandoned ('timeout' | 'network' | 'overloaded' | 'credits' | 'other'). */
  reason: string
}

/**
 * Options accepted by `streamForProvider`. Omitting the whole object keeps the
 * default retry behaviour (maxRetries 3, base 400ms); failover is opt-in.
 */
export interface StreamForProviderOptions {
  retry?: AiRetryPolicy
  /**
   * Ordered fallback provider sequence, tried after the primary fails. The
   * primary is tried first regardless of its position here (duplicates of the
   * primary are dropped so it is never tried twice in a row).
   */
  fallbackProviders?: AiProviderId[]
  /**
   * Resolve the config (apiKey/model/baseUrl) for a provider in the failover
   * chain. Defaults to reusing the primary `config`, which is only correct when
   * the whole chain shares one credential/model — a cross-vendor tenant must
   * supply this (e.g. `(id) => settings.providers[id]`).
   */
  resolveConfig?: (provider: AiProviderId) => AiProviderConfig | undefined
  /** Called once per provider switch, before the fallback provider is attempted. Defaults to a no-op. */
  onProviderSwitch?: (info: ProviderSwitchInfo) => void
}

export const DEFAULT_MAX_RETRIES = 3
export const DEFAULT_RETRY_BASE_DELAY_MS = 400

const RETRYABLE_CLASSES: ReadonlySet<ProviderErrorClass> = new Set([
  'timeout',
  'network',
  'overloaded',
])

/** True when a classified failure is worth another attempt on the same provider. */
export function isRetryableErrorClass(cls: ProviderErrorClass): boolean {
  return RETRYABLE_CLASSES.has(cls)
}

/** A thrown error may carry the shared errorCode union directly (fault injection / pre-classified errors). */
function explicitErrorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const code = (err as { errorCode?: unknown }).errorCode
    if (typeof code === 'string') return code
  }
  return undefined
}

function messageText(err: unknown): string {
  let current: unknown = err
  let text = ''
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current === 'string') {
      text += ` ${current}`
      break
    }
    const e = current as { message?: unknown; cause?: unknown }
    if (typeof e.message === 'string') text += ` ${e.message}`
    current = e.cause
  }
  return text
}

// A last-resort hint for timeouts that arrive without an AiTimeoutError instance
// (e.g. a wrapper embedding the text). Checked after the structured classifiers.
const TIMEOUT_PATTERN = /timed out|\btimeout\b|ETIMEDOUT|ERR_TIMED_OUT|UND_ERR_CONNECT_TIMEOUT/i

/**
 * Map a thrown provider failure onto the ai-provider error taxonomy.
 *
 * Ordering matters: credits/quota is classified BEFORE overloaded because a 429
 * whose body carries a quota notice must not be retried, and overloaded is
 * checked before the raw network/timeout text patterns so a 503 is never
 * misread as connectivity.
 */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (err instanceof AiCreditsError || isAiQuotaExhaustedError(err)) return 'credits'
  if (explicitErrorCode(err) === 'credits') return 'credits'
  if (err instanceof AiTimeoutError || explicitErrorCode(err) === 'timeout') return 'timeout'
  if (isAiOverloadedError(err)) return 'overloaded'
  if (explicitErrorCode(err) === 'overloaded') return 'overloaded'
  if (isAiNetworkError(err)) return 'network'
  if (explicitErrorCode(err) === 'network') return 'network'
  if (TIMEOUT_PATTERN.test(messageText(err))) return 'timeout'
  return 'other'
}

/**
 * Exponential backoff with "equal jitter": the wait is `ceil/2 + rand(0..ceil/2)`
 * where `ceil = baseDelayMs * 2 ** attempt`. Jitter de-synchronizes clients that
 * failed at the same instant so they do not hammer a recovering gateway together.
 */
export function retryBackoffMs(baseDelayMs: number, attempt: number): number {
  const ceiling = baseDelayMs * 2 ** attempt
  const half = ceiling / 2
  return Math.round(half + Math.random() * half)
}

/** Abort-aware sleep; resolves immediately once `signal` is aborted so the caller is never blocked. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // Node timers keep the event loop alive; do not let a pending backoff delay do so.
    ;(timer as { unref?: () => void }).unref?.()
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
