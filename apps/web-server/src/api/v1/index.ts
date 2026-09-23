/**
 * GenOffice REST API v1 — stable surface for third-party integrators.
 *
 * Every endpoint declared here carries an APIv1 contract:
 *   - URL paths are frozen until v2 ships (6-month deprecation after).
 *   - Request / response JSON shapes are documented in `docs/api/rest-api.md`
 *     and the typedoc-generated reference.
 *   - Error envelopes follow the same `{ error: { message, code, channel? } }`
 *     shape used by /api/ipc/:channel so a single client error helper can
 *     handle both transports.
 *
 * Auth: JWT (HS256 by default; flip to RS256 by setting GENOFFICE_JWT_ALG=RS256
 * + GENOFFICE_JWT_PUBLIC_KEY). The web-server already reads `WEB_TOKEN` for
 * the IPC gate; JWT here uses a separate `GENOFFICE_JWT_SECRET` so the two
 * surfaces can be rotated independently.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson, sendError, sendIpcError } from './http-utils'
import { handleAuthJwt, handleOAuthToken } from './auth'
import { handleFilesList, handleFilesCreate, handleFilesGet, handleFilesDelete, handleFilesIssueJwt, handleFilesCallback } from './files'
import { handleAiCapabilities, handleAiChat, handleAiTranslate, handleAiImage, handleAiSkill } from './ai'
import { handleKbSearch, handleKbEntries } from './kb'
import { handleWebhooksUpsert, handleWebhooksDelete, handleCallbacksFire } from './webhooks'
import {
  handleFilesCommentsList,
  handleFilesCommentsGet,
  handleFilesCommentsAdd,
  handleFilesCommentsPatch,
  handleFilesCommentsDelete,
} from './comments'
import {
  handleFilesVersionsList,
  handleFilesVersionsGet,
  handleFilesVersionsCreate,
  handleFilesVersionsRestore,
  handleFilesVersionsDelete,
} from './versions'
import { handleWebhooksDlq, handleWebhooksDlqEntry } from './webhooks-dlq'
import { handleHealth, handleChangelog, handleMetrics, handleMeta } from './meta'
import { handleEmbedNonce, handleEmbedVerifyNonce, handleEmbedReleaseNonce } from './embed-nonce'

export interface ApiV1Context {
  request: IncomingMessage
  response: ServerResponse
  pathname: string
  method: string
}

/**
 * Percent-decode a raw path segment without throwing.
 *
 * `decodeURIComponent('%')` throws `URIError: URI malformed`, which the
 * dispatcher previously let bubble to the catch-all — a single malformed
 * request (`GET /api/v1/files/%/comments`) produced a `500
 * {"error":{"message":"URI malformed"}}` with no `code`/`channel` and no
 * 4xx classification. A bad encoding is unambiguously the caller's fault,
 * so return `null` and let the caller answer 400 INVALID_ARGUMENT. This is
 * the same defect class the IPC bridge already handles for
 * `/api/ipc/%` channels (sdk1 §11.108) and `/api/html/preview/%`.
 */
function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/**
 * 400 INVALID_ARGUMENT envelope for a path segment that failed percent
 * decoding. Shared by every decoded `:id` / `:cid` / `:vid` route so a
 * malformed escape answers consistently instead of leaking
 * `500 {"error":{"message":"URI malformed"}}` (no `code`, no `channel`).
 */
function sendBadEncoding(ctx: ApiV1Context): true {
  sendError(ctx.response, 400, 'invalid percent-encoding in path segment', 'INVALID_ARGUMENT', ctx.pathname)
  return true
}

/**
 * Single dispatch entry. Returns true if the request was handled, false
 * otherwise so the caller can fall through to the next layer.
 *
 * Routing rules:
 *   - Method must match exactly (no implicit GET-as-HEAD).
 *   - Path matching is exact or with :id placeholder (no wildcards).
 *   - Unknown paths return false; the outer index.ts then 404s.
 */
export async function handleApiV1(ctx: ApiV1Context): Promise<boolean> {
  const { pathname, method } = ctx

  // meta
  if (pathname === '/api/v1/health' && method === 'GET') return handleHealth(ctx)
  if (pathname === '/api/v1/metrics' && method === 'GET') return handleMetrics(ctx)
  if (pathname === '/api/v1/changelog' && method === 'GET') return handleChangelog(ctx)
  if (pathname === '/api/v1/meta' && method === 'GET') return handleMeta(ctx)

  // auth
  if (pathname === '/api/v1/auth/jwt' && method === 'POST') return handleAuthJwt(ctx)
  if (pathname === '/api/v1/auth/oauth/token' && method === 'POST') return handleOAuthToken(ctx)

  // files
  if (pathname === '/api/v1/files' && method === 'GET') return handleFilesList(ctx)
  if (pathname === '/api/v1/files' && method === 'POST') return handleFilesCreate(ctx)
  const fileGet = matchId(pathname, '/api/v1/files')
  if (fileGet) {
    // Decode the raw segment so IDs with percent-escapes resolve to the
    // same name the sub-routes (`/jwt`, `/versions`, …) see, and so a
    // traversal lands on the §11.114 containment guard (400) instead of
    // being treated as a literal filename (404). A malformed escape is a
    // caller error → 400, never a 500 `URI malformed` leak.
    const id = safeDecode(fileGet)
    if (id === null) return sendBadEncoding(ctx)
    if (method === 'GET') return handleFilesGet(ctx, id)
    if (method === 'DELETE') return handleFilesDelete(ctx, id)
  }
  // Sub-path routes: /api/v1/files/:id/jwt and /api/v1/files/:id/callback.
  // matchId() returns null when the remainder contains slashes, so we
  // route these directly via regex. Without this, /api/v1/files/foo/callback
  // bypasses the v1 dispatcher and falls through to the SPA fallback.
  const fileJwtMatch = /^\/api\/v1\/files\/([^/]+)\/jwt$/.exec(pathname)
  if (fileJwtMatch && method === 'POST') {
    const id = safeDecode(fileJwtMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesIssueJwt(ctx, id)
  }
  const fileCallbackMatch = /^\/api\/v1\/files\/([^/]+)\/callback$/.exec(pathname)
  if (fileCallbackMatch && method === 'POST') {
    const id = safeDecode(fileCallbackMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesCallback(ctx, id)
  }

  // Comments (Kestrel M2, sdk1.md §B.5.1 #4 + §B.5.2).
  // Two patterns: /api/v1/files/:id/comments (list/add) and
  // /api/v1/files/:id/comments/:cid (get/patch/delete). Disambiguate by
  // path segment count to keep the dispatcher flat-readable.
  const fileCommentsListMatch = /^\/api\/v1\/files\/([^/]+)\/comments$/.exec(pathname)
  if (fileCommentsListMatch && method === 'GET') {
    const id = safeDecode(fileCommentsListMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesCommentsList(ctx, id)
  }
  if (fileCommentsListMatch && method === 'POST') {
    const id = safeDecode(fileCommentsListMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesCommentsAdd(ctx, id)
  }
  const fileCommentsItemMatch = /^\/api\/v1\/files\/([^/]+)\/comments\/([^/]+)$/.exec(pathname)
  if (fileCommentsItemMatch) {
    const id = safeDecode(fileCommentsItemMatch[1]!)
    const cid = safeDecode(fileCommentsItemMatch[2]!)
    if (id === null || cid === null) return sendBadEncoding(ctx)
    if (method === 'GET') return handleFilesCommentsGet(ctx, id, cid)
    if (method === 'PATCH') return handleFilesCommentsPatch(ctx, id, cid)
    if (method === 'DELETE') return handleFilesCommentsDelete(ctx, id, cid)
  }

  // Versions (Kestrel M3, sdk1.md §B.5.1 #3). Two patterns:
  // /api/v1/files/:id/versions (list/create) and
  // /api/v1/files/:id/versions/:vid[/restore] (get/restore/delete).
  // The /restore suffix is matched FIRST so it doesn't get eaten by
  // the bare /:vid route.
  const fileVersionsRestoreMatch = /^\/api\/v1\/files\/([^/]+)\/versions\/([^/]+)\/restore$/.exec(pathname)
  if (fileVersionsRestoreMatch && method === 'POST') {
    const id = safeDecode(fileVersionsRestoreMatch[1]!)
    const vid = safeDecode(fileVersionsRestoreMatch[2]!)
    if (id === null || vid === null) return sendBadEncoding(ctx)
    return handleFilesVersionsRestore(ctx, id, vid)
  }
  const fileVersionsListMatch = /^\/api\/v1\/files\/([^/]+)\/versions$/.exec(pathname)
  if (fileVersionsListMatch && method === 'GET') {
    const id = safeDecode(fileVersionsListMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesVersionsList(ctx, id)
  }
  if (fileVersionsListMatch && method === 'POST') {
    const id = safeDecode(fileVersionsListMatch[1]!)
    if (id === null) return sendBadEncoding(ctx)
    return handleFilesVersionsCreate(ctx, id)
  }
  const fileVersionsItemMatch = /^\/api\/v1\/files\/([^/]+)\/versions\/([^/]+)$/.exec(pathname)
  if (fileVersionsItemMatch) {
    const id = safeDecode(fileVersionsItemMatch[1]!)
    const vid = safeDecode(fileVersionsItemMatch[2]!)
    if (id === null || vid === null) return sendBadEncoding(ctx)
    if (method === 'GET') return handleFilesVersionsGet(ctx, id, vid)
    if (method === 'DELETE') return handleFilesVersionsDelete(ctx, id, vid)
  }

  // ai
  if (pathname === '/api/v1/ai/capabilities' && method === 'GET') return handleAiCapabilities(ctx)
  if (pathname === '/api/v1/ai/chat' && method === 'POST') return handleAiChat(ctx)
  if (pathname === '/api/v1/ai/translate' && method === 'POST') return handleAiTranslate(ctx)
  if (pathname === '/api/v1/ai/image' && method === 'POST') return handleAiImage(ctx)
  const skillMatch = /^\/api\/v1\/ai\/skill\/([a-z0-9._-]+)$/.exec(pathname)
  if (skillMatch && method === 'POST') return handleAiSkill(ctx, skillMatch[1])

  // kb
  if (pathname === '/api/v1/kb/search' && method === 'GET') return handleKbSearch(ctx)
  if (pathname === '/api/v1/kb/entries' && method === 'GET') return handleKbEntries(ctx)

  // webhooks
  if (pathname === '/api/v1/webhooks' && method === 'POST') return handleWebhooksUpsert(ctx)
  if (pathname === '/api/v1/webhooks' && method === 'DELETE') return handleWebhooksDelete(ctx)
  if (pathname === '/api/v1/callbacks' && method === 'POST') return handleCallbacksFire(ctx)

  // webhook dead-letter queue (sdk1.md §11.33)
  if (handleWebhooksDlq(ctx)) return true
  if (pathname.startsWith('/api/v1/webhooks/dlq/')) {
    return handleWebhooksDlqEntry(ctx)
  }

  // embed nonce session (§11.26 — server-side nonce ↔ session binding)
  if (pathname === '/api/v1/embed/nonce' && method === 'POST') return handleEmbedNonce(ctx)
  if (pathname === '/api/v1/embed/verify-nonce' && method === 'POST') return handleEmbedVerifyNonce(ctx)
  if (pathname === '/api/v1/embed/nonce' && method === 'DELETE') return handleEmbedReleaseNonce(ctx)

  return false
}

function matchId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(`${prefix}/`)) return null
  const rest = pathname.slice(prefix.length + 1)
  if (!rest || rest.includes('/')) return null
  return rest
}

/**
 * sdk1 §11.111 — route table for wrong-method 405 detection.
 *
 * The v1 dispatcher checks each handler with a literal
 * `pathname === X && method === Y` test; when a request comes in with
 * a pathname that matches some v1 route but the wrong HTTP method,
 * the dispatcher falls through to the catch-all 404 NOT_FOUND envelope.
 * That's an RFC 7231 violation: an existing resource reached with the
 * wrong method must respond 405 with an `Allow:` header listing the
 * methods that ARE supported, NOT 404 (404 is for "resource does not
 * exist"). This table is consulted by the catch-all so wrong-method
 * requests get a clean 405 with the correct Allow list.
 *
 * The patterns MUST stay in sync with the handler if-chains above;
 * a missing pattern means a wrong-method request will silently become
 * 404 instead of 405. Tests under `tests/v1-wrong-method-405-sweep-e2e.test.ts`
 * fail loudly if a route is added without an entry here.
 */
export interface V1RouteInfo {
  /** Pattern that matches the pathname (params use [^/]+). */
  pattern: RegExp
  /** HTTP methods supported by the matched route, uppercase. */
  methods: string[]
}

export const v1Routes: V1RouteInfo[] = [
  // meta (GET only)
  { pattern: /^\/api\/v1\/health$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/metrics$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/changelog$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/meta$/, methods: ['GET'] },
  // auth (POST only)
  { pattern: /^\/api\/v1\/auth\/jwt$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/auth\/oauth\/token$/, methods: ['POST'] },
  // files (collection + item + sub-paths)
  { pattern: /^\/api\/v1\/files$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/v1\/files\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^\/api\/v1\/files\/[^/]+\/jwt$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/files\/[^/]+\/callback$/, methods: ['POST'] },
  // comments
  { pattern: /^\/api\/v1\/files\/[^/]+\/comments$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/v1\/files\/[^/]+\/comments\/[^/]+$/, methods: ['GET', 'PATCH', 'DELETE'] },
  // versions
  { pattern: /^\/api\/v1\/files\/[^/]+\/versions$/, methods: ['GET', 'POST'] },
  { pattern: /^\/api\/v1\/files\/[^/]+\/versions\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^\/api\/v1\/files\/[^/]+\/versions\/[^/]+\/restore$/, methods: ['POST'] },
  // ai
  { pattern: /^\/api\/v1\/ai\/capabilities$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/ai\/chat$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/ai\/translate$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/ai\/image$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/ai\/skill\/[a-z0-9._-]+$/, methods: ['POST'] },
  // kb
  { pattern: /^\/api\/v1\/kb\/search$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/kb\/entries$/, methods: ['GET'] },
  // webhooks
  { pattern: /^\/api\/v1\/webhooks$/, methods: ['POST', 'DELETE'] },
  { pattern: /^\/api\/v1\/webhooks\/dlq$/, methods: ['GET'] },
  { pattern: /^\/api\/v1\/webhooks\/dlq\/[^/]+$/, methods: ['GET', 'DELETE'] },
  { pattern: /^\/api\/v1\/webhooks\/dlq\/[^/]+\/replay$/, methods: ['POST'] },
  { pattern: /^\/api\/v1\/callbacks$/, methods: ['POST'] },
  // embed nonce
  { pattern: /^\/api\/v1\/embed\/nonce$/, methods: ['POST', 'DELETE'] },
  { pattern: /^\/api\/v1\/embed\/verify-nonce$/, methods: ['POST'] },
]

/**
 * Resolve a v1 route from its pathname. Returns the route info if a
 * known pattern matches, else null. Order matters: patterns are
 * declared most-specific first (longer prefixes / more segments) so
 * a literal segment never gets eaten by a more-generic [^/]+ match.
 */
export function findV1Route(pathname: string): V1RouteInfo | null {
  for (const route of v1Routes) {
    if (route.pattern.test(pathname)) return route
  }
  return null
}

export { sendJson, sendError, sendIpcError, readBody }
