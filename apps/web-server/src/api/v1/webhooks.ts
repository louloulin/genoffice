/**
 * /api/v1/webhooks — webhook subscription management.
 *
 * Pairs with the file-scoped save callback registration in `/api/v1/files/:id/callback`.
 * Top-level webhooks are org-wide subscriptions (e.g. "notify me when any
 * AI job completes") — store them in the same `webhooks.json` file but
 * keyed by a synthetic org id rather than a file id.
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody, isValidWebhookUrl, isValidEventList } from './http-utils'
import {
  saveCallbackForUser,
  deleteCallbackForUser,
  getCallbackForUser,
  fireCallback,
  pushFailedDeliveriesToDlq,
} from '../../common/webhooks-store'
import { purgeDeadLettersForUrl } from '../../common/webhooks-dlq'
import { requireScopeFromHeaders } from './auth'

/**
 * `POST /api/v1/webhooks`
 *
 * Register or replace a per-user webhook subscription. Body: `{ url, events? }`. Default events: `["file.saved", "ai.completed"]`.
 *
 * **Required scope**: `webhooks:manage`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleWebhooksUpsert(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'webhooks:manage')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'webhooks:upsert')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: { url?: string; events?: string[] }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'webhooks:upsert')
    return true
  }
  if (!isValidWebhookUrl(body.url)) {
    sendError(ctx.response, 400, 'url must be a string with http: or https: scheme', 'INVALID_ARGUMENT', 'webhooks:upsert')
    return true
  }
  // §11.117: validate events is an array of non-empty strings. null /
  // undefined / omitted → use the default event list (matches §11.115
  // `null doc` semantics: serializer produces null for "unset", not
  // "explicit empty"). An explicit non-array like `"file.saved"` or
  // `[1,2,3]` would be stored verbatim, then `[1,2,3].includes('file.saved')`
  // returns false → webhook silently never fires.
  let events: string[]
  if (body.events === undefined || body.events === null) {
    events = ['file.saved', 'ai.completed', 'comment.added', 'comment.resolved', 'comment.removed']
  } else if (isValidEventList(body.events)) {
    events = body.events
  } else {
    sendError(ctx.response, 400, 'events must be an array of non-empty strings', 'INVALID_ARGUMENT', 'webhooks:upsert')
    return true
  }
  // Org-wide subs are keyed by JWT `sub`. We use a dedicated
  // `byUser` index in webhooks-store (sdk1.md §11.93) so they receive
  // every event the server fires, not just per-file ones. The previous
  // implementation crammed them into the `byFile` map under a synthetic
  // `user:<sub>` key, which meant comment / file.saved events for any
  // other fileId would skip the receiver entirely.
  saveCallbackForUser(caller.sub, {
    url: body.url,
    events,
    createdAt: Date.now(),
  })
  sendJson(ctx.response, 201, { ok: true, subscriber: caller.sub, url: body.url })
  return true
}

/**
 * `DELETE /api/v1/webhooks`
 *
 * Remove the per-user webhook subscription.
 *
 * **Required scope**: `webhooks:manage`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleWebhooksDelete(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'webhooks:manage')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'webhooks:delete')
    return true
  }
  const caller = { sub: gate.payload.sub }
  // Capture the URL before deletion so we can purge stale DLQ entries
  // (sdk1.md §11.33.4): every DLQ entry whose target matches this URL
  // becomes a dead letter with no valid receiver once the subscription
  // is gone. Purging at delete-time keeps the DLQ focused on
  // actionable items; hosts see the count in the response.
  const existing = getCallbackForUser(caller.sub)
  const removed = deleteCallbackForUser(caller.sub)
  const dlqPurged = existing ? purgeDeadLettersForUrl(existing.url) : { removed: 0, ids: [] }
  sendJson(ctx.response, 200, { ok: true, removed, dlqPurged })
  return true
}

/**
 * Internal helper: invoke from any save / completion path to fan out
 * registered callbacks. Exported for the integration tests as well.
 * @public
 */
export { fireCallback, getCallbackForUser, pushFailedDeliveriesToDlq }

/**
 * `POST /api/v1/callbacks/fire`
 *
 * Admin / test endpoint: fire a webhook on demand without going through a real save. Useful for integration testing.
 *
 * **Required scope**: `admin`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleCallbacksFire(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  // Admin / test endpoint — fire a callback on demand without going through
  // a real save. Required scope: admin.
  const gate = requireScopeFromHeaders(ctx.request.headers, 'admin')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'callbacks:fire')
    return true
  }
  const caller = { sub: gate.payload.sub }
  let body: { event?: string; fileId?: string; data?: Record<string, unknown> }
  try {
    const raw = await readBody(ctx.request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'callbacks:fire')
    return true
  }
  if (typeof body.event !== 'string' || typeof body.fileId !== 'string') {
    sendError(ctx.response, 400, 'expected { event, fileId, data? }', 'INVALID_ARGUMENT', 'callbacks:fire')
    return true
  }
  const results = await fireCallback(body.event, body.fileId, body.data ?? {})
  // Mirror the save-path DLQ behavior (sdk1.md §11.33): failed
  // deliveries are recorded so hosts can replay / inspect / drop them
  // via the v1 /webhooks/dlq endpoints. Without this the admin fire
  // endpoint would silently lose failures — the previous behavior was
  // a §11.33.4 follow-up gap.
  await pushFailedDeliveriesToDlq(results, body.fileId, body.data ?? {})
  sendJson(ctx.response, 200, { ok: true, fired: body.event, deliveredCount: results.filter((r) => r.delivered).length })
  return true
}
