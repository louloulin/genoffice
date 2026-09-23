/**
 * /api/v1/kb — knowledge base search and entry listing.
 *
 * The REST surface today is read-only and proxies to the translation-core
 * knowledge base (the same backing store that powers `ai:translation-kb-*`
 * IPC channels). When the dedicated KB / RAG store lands (see roadmap M2),
 * this module will switch its IPC targets without changing the v1 contract.
 * @public
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
 * @public
 */
export async function handleKbSearch(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'kb:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'kb:search')
    return true
  }
  const url = new URL(ctx.request.url ?? '/', 'http://localhost')
  const q = url.searchParams.get('q')
  if (!q) {
    sendError(ctx.response, 400, 'expected ?q= query parameter', 'INVALID_ARGUMENT', 'kb:search')
    return true
  }
  // The `home:translate-kb-search` IPC proxies to the `kb_search` tool
  // which accepts `{ query, limit }`. The previous implementation called
  // `ai:translation-kb-resolve` with `{ term, limit }` — but that IPC is a
  // language-pair resolver (requires `targetLang`) and the `term` field is
  // not in its schema, so every kb:search call returned
  // `expected non-empty 'targetLang'`. This was discovered via interactive
  // curl probes after §11.95 smoke; see sdk1 §11.100.
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Math.min(1000, Math.max(1, Number(limitParam) || 10)) : 10
  if (limitParam && (Number.isNaN(Number(limitParam)) || Number(limitParam) < 1)) {
    sendError(ctx.response, 400, 'limit must be a positive integer', 'INVALID_ARGUMENT', 'kb:search')
    return true
  }
  const result = await invokeIpc('home:translate-kb-search', [{ query: q, limit }])
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
 * @public
 */
export async function handleKbEntries(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const gate = requireScopeFromHeaders(ctx.request.headers, 'kb:read')
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'kb:entries')
    return true
  }
  // The `ai:translation-kb-list` IPC expects `{ schema?, limit? }` per
  // apps/web-server/src/ai/chat.ts:1463. The previous REST shim sent
  // `{ lang?, domain? }` which silently no-op filtered (entries still
  // came back, so the bug was hidden). Forward `schema` (string) and
  // `limit` (clamped positive integer) only — the IPC ignores unknown
  // fields, and accepting other fields would mislead hosts about what
  // the server can actually filter by.
  const url = new URL(ctx.request.url ?? '/', 'http://localhost')
  const filters: { schema?: string; limit?: number } = {}
  const schema = url.searchParams.get('schema')
  if (schema) filters.schema = schema
  const limitParam = url.searchParams.get('limit')
  if (limitParam) {
    const n = Number(limitParam)
    if (Number.isNaN(n) || n < 1) {
      sendError(ctx.response, 400, 'limit must be a positive integer', 'INVALID_ARGUMENT', 'kb:entries')
      return true
    }
    filters.limit = Math.min(1000, n)
  }
  const result = await invokeIpc('ai:translation-kb-list', [filters])
  sendJson(ctx.response, 200, result)
  return true
}
