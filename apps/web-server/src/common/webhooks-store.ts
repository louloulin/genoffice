/**
 * Persistent webhook registry — file-scoped save callbacks.
 *
 * Stored as a single JSON document under `DATA_DIR/webhooks.json`. Restart-safe;
 * the storage backend in `file-management` is the canonical home for file
 * metadata, but webhooks are server-local state that doesn't need a backend.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'
import { DATA_DIR } from './index'

/**
 * Compute the HMAC-SHA256 signature of a raw body using the given secret.
 * Exported so tests and receivers can independently verify a delivery.
 *
 * The signature format matches GitHub's `X-Hub-Signature-256` and Stripe's
 * `Stripe-Signature` style: a `sha256=<lowercase hex>` prefix followed by
 * the HMAC digest. Receivers verify with:
 *
 *   const expected = 'sha256=' + crypto.createHmac('sha256', secret)
 *     .update(rawBody).digest('hex')
 *   crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header))
 */
export function signWebhookBody(secret: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
}


const FILE = join(DATA_DIR, 'webhooks.json')

export interface FileWebhook {
  fileId: string
  url: string
  events: string[]
  createdAt: number
  /**
   * Optional shared secret. When set, outgoing webhook deliveries carry an
   * `X-GenOffice-Signature: sha256=<hex>` header computed as
   * HMAC-SHA256(secret, rawBody). Receivers verify the signature to confirm
   * the request came from this server and was not tampered with in transit.
   * Modeled on GitHub / Stripe webhook signing (sdk1.md Appendix B.2).
   */
  secret?: string
}

interface Store {
  byFile: Record<string, FileWebhook>
}

let cache: Store | null = null

function load(): Store {
  if (cache) return cache
  try {
    if (existsSync(FILE)) {
      const parsed = JSON.parse(readFileSync(FILE, 'utf8')) as Store
      cache = { byFile: parsed.byFile ?? {} }
      return cache
    }
  } catch {
    /* fall through */
  }
  cache = { byFile: {} }
  return cache
}

function persist(): void {
  if (!cache) return
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8')
}

export function saveCallback(webhook: FileWebhook): void {
  const store = load()
  store.byFile[webhook.fileId] = webhook
  persist()
}

export function getCallback(fileId: string): FileWebhook | undefined {
  return load().byFile[fileId]
}

export function listCallbacks(): FileWebhook[] {
  return Object.values(load().byFile)
}

export function deleteCallback(fileId: string): boolean {
  const store = load()
  if (!store.byFile[fileId]) return false
  delete store.byFile[fileId]
  persist()
  return true
}

/**
 * Fire all callbacks registered for a file. Best-effort delivery: a network
 * error or 5xx from the webhook target doesn't throw — webhook delivery is
 * advisory and shouldn't break the save pipeline. Callers can re-deliver
 * from a retry queue if durability is required.
 */
export interface WebhookDeliveryResult {
  url: string
  event: string
  attempts: number
  delivered: boolean
  finalStatus: number | null
  error?: string
}

export interface WebhookDeliveryOptions {
  /** Max delivery attempts (default 3: 1 initial + 2 retries). */
  maxAttempts?: number
  /** Initial backoff in ms; doubled each retry (default 250). */
  initialBackoffMs?: number
}

/**
 * Deliver a webhook with exponential-backoff retry.
 *
 * Retries on:
 *   - network errors (fetch throws)
 *   - 5xx server errors (target is having a bad time)
 *   - 429 Too Many Requests (back off and try again)
 *
 * Does NOT retry on 2xx (success) or 4xx other than 429 (caller is at
 * fault — retrying won't help). After maxAttempts exhausted, the
 * failure is logged but the save pipeline stays unblocked; the caller
 * can persist failed deliveries to a dead-letter queue if durability
 * matters (sdk1.md §11.3 P2 follow-up).
 *
 * Per-attempt timeout is 5 s so a single slow target can't pile up
 * deliveries; total worst-case wall time is roughly 5s × maxAttempts
 * plus the sum of backoff delays.
 */
export async function fireCallback(
  event: string,
  fileId: string,
  data: Record<string, unknown>,
  opts: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryResult | null> {
  const wh = getCallback(fileId)
  if (!wh) return null
  if (wh.events.length > 0 && !wh.events.includes(event)) return null
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3)
  const initialBackoffMs = Math.max(0, opts.initialBackoffMs ?? 250)
  const body = JSON.stringify({ v: '1.0', event, ts: Math.floor(Date.now() / 1000), fileId, data })
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (wh.secret) {
    headers['X-GenOffice-Signature'] = signWebhookBody(wh.secret, body)
  }

  let lastError: string | undefined
  let lastStatus: number | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(wh.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        return { url: wh.url, event, attempts: attempt, delivered: true, finalStatus: res.status }
      }
      lastStatus = res.status
      // 4xx other than 429 are caller-fault; no retry.
      const retryable = res.status >= 500 || res.status === 429
      if (!retryable) {
        console.warn(`[webhooks] ${wh.url} returned ${res.status} for ${event} (not retrying)`)
        return { url: wh.url, event, attempts: attempt, delivered: false, finalStatus: res.status }
      }
      console.warn(`[webhooks] ${wh.url} returned ${res.status} for ${event} (attempt ${attempt}/${maxAttempts})`)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.warn(`[webhooks] delivery attempt ${attempt}/${maxAttempts} to ${wh.url} failed:`, lastError)
    }
    if (attempt < maxAttempts) {
      // Exponential backoff with full jitter: base * 2^(attempt-1), capped
      // at 8s, then jitter to avoid thundering herd on a flapping target.
      const base = initialBackoffMs * 2 ** (attempt - 1)
      const capped = Math.min(base, 8_000)
      const jitter = Math.floor(Math.random() * capped)
      await new Promise((res) => setTimeout(res, jitter))
    }
  }
  return {
    url: wh.url,
    event,
    attempts: maxAttempts,
    delivered: false,
    finalStatus: lastStatus,
    ...(lastError ? { error: lastError } : {}),
  }
}

/**
 * Save-path integration helper. Maps a saved file path to its REST v1 file
 * id (basename — the same id the REST API surfaces at /api/v1/files) and
 * fires `file.saved` on any registered callback.
 *
 * Dead-letter handling: when `fireCallback` returns a `delivered: false`
 * result, this wrapper writes the entry to the in-process DLQ
 * (`webhooks-dlq.ts`) so hosts can replay / inspect / drop it via
 * `GET/POST/DELETE /api/v1/webhooks/dlq`. The DLQ is LRU-capped at
 * 1024 entries and process-local (same durability model as the nonce
 * store and version history); see sdk1.md §11.33.
 *
 * Non-blocking: callers should not `await` this unless they need delivery
 * confirmation. Network errors and slow targets are swallowed by
 * `fireCallback`, so a flaky webhook target cannot stall the save pipeline.
 *
 * Stable contract (sdk1.md §2.1.D webhook envelope):
 *   { v: '1.0', event, ts, fileId, data: { path, size?, format? } }
 */
export function notifyFileSaved(filePath: string, extra: { size?: number; format?: string } = {}): void {
  const fileId = filePath.split(/[\\/]/).pop() ?? filePath
  // fire-and-forget; on failure the entry is pushed to the DLQ so hosts
  // can replay/inspect it. The DLQ import is deferred (dynamic) so this
  // module stays circular-import-free with webhooks-dlq.ts.
  void fireCallback('file.saved', fileId, { path: filePath, ...extra }).then(async (result) => {
    if (!result || result.delivered) return
    // Lazy require: avoids the cyclic-import dance and only loads DLQ
    // code paths when something actually fails.
    const { pushDeadLetter } = await import('./webhooks-dlq')
    // Caller-fault 4xx (other than 429) is non-retryable — fireCallback
    // exits after a single attempt. We surface those as `non_retryable_4xx`
    // so operators can branch their tooling (e.g. fix the URL / auth
    // header) without confusing them with transient server-side failures.
    const reason: 'max_attempts' | 'non_retryable_4xx' =
      result.attempts === 1 && result.finalStatus !== null && result.finalStatus >= 400 && result.finalStatus < 500 && result.finalStatus !== 429
        ? 'non_retryable_4xx'
        : 'max_attempts'
    pushDeadLetter({
      url: result.url,
      event: result.event,
      fileId,
      body: JSON.stringify({ v: '1.0', event: result.event, ts: Math.floor(Date.now() / 1000), fileId, data: { path: filePath, ...extra } }),
      attempts: result.attempts,
      lastStatus: result.finalStatus,
      lastError: result.error ?? null,
      reason,
    })
  }).catch(() => {
    // DLQ push itself is best-effort; if even that fails the original
    // failure is already logged by fireCallback.
  })
}
