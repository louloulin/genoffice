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
export async function fireCallback(event: string, fileId: string, data: Record<string, unknown>): Promise<void> {
  const wh = getCallback(fileId)
  if (!wh) return
  if (wh.events.length > 0 && !wh.events.includes(event)) return
  try {
    const body = JSON.stringify({ v: '1.0', event, ts: Math.floor(Date.now() / 1000), fileId, data })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (wh.secret) {
      headers['X-GenOffice-Signature'] = signWebhookBody(wh.secret, body)
    }
    const res = await fetch(wh.url, {
      method: 'POST',
      headers,
      body,
      // 5-second cap so a slow webhook target doesn't pile up deliveries.
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) {
      // Log only — webhook delivery is advisory.
      console.warn(`[webhooks] ${wh.url} returned ${res.status} for ${event}`)
    }
  } catch (err) {
    console.warn(`[webhooks] failed to deliver ${event} to ${wh.url}:`, err instanceof Error ? err.message : err)
  }
}

/**
 * Save-path integration helper. Maps a saved file path to its REST v1 file
 * id (basename — the same id the REST API surfaces at /api/v1/files) and
 * fires `file.saved` on any registered callback.
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
  // fire-and-forget; errors are logged inside fireCallback
  void fireCallback('file.saved', fileId, { path: filePath, ...extra })
}
