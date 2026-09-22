/**
 * v1 endpoint · webhook dead-letter queue (sdk1.md §11.33).
 *
 * Hosts inspect, replay, and acknowledge dropped deliveries via:
 *
 *   GET    /api/v1/webhooks/dlq              list (newest first, ?limit=N)
 *   GET    /api/v1/webhooks/dlq/:id          fetch one entry
 *   POST   /api/v1/webhooks/dlq/:id/replay   re-deliver; removes on 2xx
 *   DELETE /api/v1/webhooks/dlq/:id          drop / acknowledge
 *
 * Required scope: `webhooks:manage` (same gate as upsert / delete of the
 * webhook registry). The DLQ is process-local: a server restart clears
 * it. Persistent DLQ needs Redis/Postgres — explicitly out of scope.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  deleteDeadLetter,
  getDeadLetter,
  listDeadLetters,
  replayDeadLetter,
} from '../../common/webhooks-dlq'
import {
  sendError,
  sendJson,
} from './http-utils'
import { requireScopeFromHeaders } from './auth'

const MAX_LIMIT = 200

function gateScope(request: IncomingMessage, response: ServerResponse):
  | { ok: true }
  | { ok: false } {
  const gate = requireScopeFromHeaders(request.headers, 'webhooks:manage')
  if (gate.ok) return { ok: true }
  sendError(response, gate.status, gate.message, gate.code, 'webhooks:dlq')
  return { ok: false }
}

function handleDlqList(ctx: { request: IncomingMessage; response: ServerResponse; pathname: string }): boolean {
  if (ctx.pathname !== '/api/v1/webhooks/dlq') return false
  const gate = gateScope(ctx.request, ctx.response)
  if (!gate.ok) return true
  const url = new URL(ctx.request.url ?? '/', 'http://placeholder')
  const rawLimit = url.searchParams.get('limit')
  let limit = 50
  if (rawLimit !== null) {
    const n = Number(rawLimit)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      sendError(ctx.response, 400, 'limit must be a positive integer', 'INVALID_ARGUMENT', 'webhooks:dlq')
      return true
    }
    limit = Math.min(n, MAX_LIMIT)
  }
  const entries = listDeadLetters({ limit })
  sendJson(ctx.response, 200, {
    entries,
    count: entries.length,
    limit,
    /** Note: `total` is intentionally omitted — the store is a ring buffer,
     * so we can't cheaply report "how many total entries exist beyond the
     * returned slice". Hosts that need pagination should use cursor-based
     * listing in a future iteration. */
  })
  return true
}

function handleDlqEntry(ctx: { request: IncomingMessage; response: ServerResponse; pathname: string; method: string }): boolean {
  if (ctx.pathname === '/api/v1/webhooks/dlq') return false
  const gate = gateScope(ctx.request, ctx.response)
  if (!gate.ok) return true
  // path: /api/v1/webhooks/dlq/:id  or  /api/v1/webhooks/dlq/:id/replay
  const rest = ctx.pathname.slice('/api/v1/webhooks/dlq/'.length)
  const segments = rest.split('/').filter(Boolean)
  if (segments.length === 0 || segments.length > 2) {
    sendError(ctx.response, 400, 'expected /api/v1/webhooks/dlq/:id[/replay]', 'INVALID_ARGUMENT', 'webhooks:dlq')
    return true
  }
  const id = segments[0]!
  const action = segments[1] ?? null

  // GET single
  if (ctx.method === 'GET' && action === null) {
    const entry = getDeadLetter(id)
    if (!entry) {
      sendError(ctx.response, 404, `dlq entry ${id} not found`, 'NOT_FOUND', 'webhooks:dlq')
      return true
    }
    sendJson(ctx.response, 200, entry)
    return true
  }

  // POST replay
  if (ctx.method === 'POST' && action === 'replay') {
    void (async () => {
      const result = await replayDeadLetter(id)
      if (!result.ok && result.reason === 'unknown_id') {
        sendError(ctx.response, 404, `dlq entry ${id} not found`, 'NOT_FOUND', 'webhooks:dlq')
        return
      }
      if (result.ok) {
        const inner = result.result
        sendJson(ctx.response, 200, {
          replayed: true,
          delivered: inner.delivered,
          attempts: inner.attempts,
          finalStatus: inner.finalStatus,
          removed: result.removed,
          ...(result.removed ? {} : { entry: result.entry }),
          ...('lastError' in inner && inner.lastError ? { lastError: inner.lastError } : {}),
        })
      }
    })()
    return true
  }

  // DELETE single
  if (ctx.method === 'DELETE' && action === null) {
    const removed = deleteDeadLetter(id)
    if (!removed) {
      sendError(ctx.response, 404, `dlq entry ${id} not found`, 'NOT_FOUND', 'webhooks:dlq')
      return true
    }
    sendJson(ctx.response, 200, { deleted: true, id })
    return true
  }

  sendError(ctx.response, 405, `unsupported method ${ctx.method} for ${ctx.pathname}`, 'METHOD_NOT_ALLOWED', 'webhooks:dlq')
  return true
}

export const handleWebhooksDlq = handleDlqList
export const handleWebhooksDlqEntry = handleDlqEntry
