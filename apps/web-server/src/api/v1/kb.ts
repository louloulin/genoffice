/**
 * /api/v1/kb — knowledge base search and entry listing.
 *
 * The REST surface today is read-only and proxies to the translation-core
 * knowledge base (the same backing store that powers `ai:translation-kb-*`
 * IPC channels). When the dedicated KB / RAG store lands (see roadmap M2),
 * this module will switch its IPC targets without changing the v1 contract.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError } from './http-utils'
import { invokeIpc } from './ipc-bridge'
import { requireScopeFromHeaders } from './auth'

/**
 * `GET /api/v1/kb/search?q=...`
 *
 * Search the translation knowledge base for entries matching the query term.
 *
 * **Required scope**: `kb:read`
 *
 * **Errors**: `400 INVALID_ARGUMENT`, `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 */
export async function handleKbSearch(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'kb:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'kb:search')
    return true
  }
  const q = new URL(ctx.request.url ?? '/', 'http://localhost').searchParams.get('q')
  if (!q) {
    sendError(ctx.response, 400, 'expected ?q= query parameter', 'INVALID_ARGUMENT', 'kb:search')
    return true
  }
  const limit = Number(new URL(ctx.request.url ?? '/', 'http://localhost').searchParams.get('limit') || '10')
  const result = await invokeIpc('ai:translation-kb-resolve', [{ term: q, limit }])
  sendJson(ctx.response, 200, result)
  return true
}

/**
 * `GET /api/v1/kb/entries`
 *
 * List KB entries with optional `lang` and `domain` filters.
 *
 * **Required scope**: `kb:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 */
export async function handleKbEntries(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'kb:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'kb:entries')
    return true
  }
  const url = new URL(ctx.request.url ?? '/', 'http://localhost')
  const filters = {
    ...(url.searchParams.get('lang') ? { lang: url.searchParams.get('lang') } : {}),
    ...(url.searchParams.get('domain') ? { domain: url.searchParams.get('domain') } : {}),
  }
  const result = await invokeIpc('ai:translation-kb-list', [filters])
  sendJson(ctx.response, 200, result)
  return true
}
