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
import { handleHealth, handleChangelog } from './meta'
import { handleEmbedNonce, handleEmbedVerifyNonce } from './embed-nonce'

export interface ApiV1Context {
  request: IncomingMessage
  response: ServerResponse
  pathname: string
  method: string
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
  if (pathname === '/api/v1/changelog' && method === 'GET') return handleChangelog(ctx)

  // auth
  if (pathname === '/api/v1/auth/jwt' && method === 'POST') return handleAuthJwt(ctx)
  if (pathname === '/api/v1/auth/oauth/token' && method === 'POST') return handleOAuthToken(ctx)

  // files
  if (pathname === '/api/v1/files' && method === 'GET') return handleFilesList(ctx)
  if (pathname === '/api/v1/files' && method === 'POST') return handleFilesCreate(ctx)
  const fileGet = matchId(pathname, '/api/v1/files')
  if (fileGet && method === 'GET') return handleFilesGet(ctx, fileGet)
  if (fileGet && method === 'DELETE') return handleFilesDelete(ctx, fileGet)
  // Sub-path routes: /api/v1/files/:id/jwt and /api/v1/files/:id/callback.
  // matchId() returns null when the remainder contains slashes, so we
  // route these directly via regex. Without this, /api/v1/files/foo/callback
  // bypasses the v1 dispatcher and falls through to the SPA fallback.
  const fileJwtMatch = /^\/api\/v1\/files\/([^/]+)\/jwt$/.exec(pathname)
  if (fileJwtMatch && method === 'POST') return handleFilesIssueJwt(ctx, decodeURIComponent(fileJwtMatch[1]))
  const fileCallbackMatch = /^\/api\/v1\/files\/([^/]+)\/callback$/.exec(pathname)
  if (fileCallbackMatch && method === 'POST') return handleFilesCallback(ctx, decodeURIComponent(fileCallbackMatch[1]))

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

  // embed nonce session (§11.26 — server-side nonce ↔ session binding)
  if (pathname === '/api/v1/embed/nonce' && method === 'POST') return handleEmbedNonce(ctx)
  if (pathname === '/api/v1/embed/verify-nonce' && method === 'POST') return handleEmbedVerifyNonce(ctx)

  return false
}

function matchId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(`${prefix}/`)) return null
  const rest = pathname.slice(prefix.length + 1)
  if (!rest || rest.includes('/')) return null
  return rest
}

export { sendJson, sendError, sendIpcError, readBody }
