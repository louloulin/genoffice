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
 * Schema keys the underlying `kb_list` tool accepts (mirrors `SCHEMA_KEYS`
 * in `packages/agent-skills/src/extensions/translate-skill.ts`). Forwarding
 * an unknown key made the IPC answer `200 {ok:false}` (sdk1 §11.116), so
 * the REST layer rejects it up front.
 */
const KB_SCHEMA_KEYS = ['term', 'forbidden', 'brand', 'styleRule', 'customerPreference'] as const

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
  const qRaw = url.searchParams.get('q')
  // sdk1 §11.112: reject empty / whitespace-only `q` as 400 instead of
  // forwarding to IPC and getting back 200 + {ok:false, error:'kb_search:
  // \`query\` is required'}. The REST layer catches it deterministically
  // and returns the standard invalid-argument envelope. Trim before
  // forwarding so the IPC never sees a leading/trailing-space search.
  const q = qRaw?.trim() ?? ''
  if (!q) {
    sendError(ctx.response, 400, 'expected non-empty ?q= query parameter', 'INVALID_ARGUMENT', 'kb:search')
    return true
  }
  // The `home:translate-kb-search` IPC proxies to the `kb_search` tool
  // which accepts `{ query, limit }`. The previous implementation called
  // `ai:translation-kb-resolve` with `{ term, limit }` — but that IPC is a
  // language-pair resolver (requires `targetLang`) and the `term` field is
  // not in its schema, so every kb:search call returned
  // `expected non-empty 'targetLang'`. This was discovered via interactive
  // curl probes after §11.95 smoke; see sdk1 §11.100.
  // sdk1 §11.116: `limit` must be validated against the IPC's ACTUAL
  // contract, not an aspirational one. The `kb_search` tool enforces
  // `kbListLimit(limit, 20, 100)` — an integer in 1..100 — and answers
  // `{ok:false, error:'kb_search: `limit` must be an integer between 1
  // and 100 (got 1.5)'}` for anything else. The old REST layer only
  // rejected `< 1` / non-numeric and clamped the top at 1000, so
  // `?limit=1.5` and `?limit=101..1000` forwarded straight to the IPC and
  // came back as `200` with an `{ok:false}` envelope — the exact
  // §11.103/§11.112-class IPC-shape leak where a 200 is not a real
  // success. Integer-ness and the 1..100 ceiling are now enforced here.
  const limitParam = url.searchParams.get('limit')
  let limit = 10
  if (limitParam !== null && limitParam !== '') {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) {
      sendError(ctx.response, 400, 'limit must be a positive integer', 'INVALID_ARGUMENT', 'kb:search')
      return true
    }
    limit = Math.min(100, n)
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
  // sdk1 §11.116: same class as `kb/search` above. `kb_list` enforces
  // `kbListLimit(limit)` — integer in 1..1000 — and answers
  // `{ok:false, error:'kb_list: `limit` must be an integer between 1 and
  // 1000 (got 1.5)'}` otherwise. The old REST check accepted any positive
  // number (`1.5` passed) and the schema filter was forwarded verbatim
  // even when it was not one of the five known schema keys, so
  // `?schema=nonsense` also produced `200 {ok:false}`. Both are now
  // rejected at the REST layer with a real 400.
  const url = new URL(ctx.request.url ?? '/', 'http://localhost')
  const filters: { schema?: string; limit?: number } = {}
  const schema = url.searchParams.get('schema')
  if (schema !== null && schema !== '') {
    if (!(KB_SCHEMA_KEYS as readonly string[]).includes(schema)) {
      sendError(
        ctx.response,
        400,
        `schema must be one of ${KB_SCHEMA_KEYS.join(', ')}`,
        'INVALID_ARGUMENT',
        'kb:entries',
      )
      return true
    }
    filters.schema = schema
  }
  const limitParam = url.searchParams.get('limit')
  if (limitParam !== null && limitParam !== '') {
    const n = Number(limitParam)
    if (!Number.isInteger(n) || n < 1) {
      sendError(ctx.response, 400, 'limit must be a positive integer', 'INVALID_ARGUMENT', 'kb:entries')
      return true
    }
    filters.limit = Math.min(1000, n)
  }
  const result = await invokeIpc('ai:translation-kb-list', [filters])
  sendJson(ctx.response, 200, result)
  return true
}
