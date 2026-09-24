/**
 * /api/v1/embed/nonce + /api/v1/embed/verify-nonce — server-side nonce ↔
 * session binding for the iframe Embed handshake.
 *
 * Background (sdk1.md §11.26 / §11.20.5):
 *   - The host SDK normally generates the handshake nonce client-side and
 *     stuffs it into the iframe URL (`?nonce=...`). The iframe's bridge
 *     echoes the nonce in its `ready` postMessage payload, and the SDK
 *     verifies the match. This is a CSRF / cross-origin defense.
 *   - For defense-in-depth, this pair of endpoints lets the host SDK ask
 *     the server: "did you know this nonce when the iframe was opened?".
 *     The server only knows nonces it minted itself, so a tampered iframe
 *     (proxied / replaced by an attacker) will fail the verification.
 *
 * Endpoints:
 *   - `POST /api/v1/embed/nonce`
 *       body: `{ docId: string, ttlMs?: number }`
 *       returns: `{ sessionId, nonce, expiresAt }`
 *       scope: `files:read`
 *   - `POST /api/v1/embed/verify-nonce`
 *       body: `{ sessionId: string, nonce: string }`
 *       returns: `{ valid: boolean, reason?: 'unknown' | 'expired', expiresAt?: number }`
 *       scope: `files:read`
 *
 * **Errors**: `401 UNAUTHENTICATED`, `403 FORBIDDEN`, `400 BAD_REQUEST`
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { sendJson, sendError, readBody } from './http-utils'
import { requireScopeFromHeaders, type JwtPayload } from './auth'
import { mintEmbedNonce, verifyEmbedNonce, removeEmbedNonce } from '../../embed/nonce-store'

const DEFAULT_TTL_MS = 5 * 60 * 1000
const MAX_TTL_MS = 60 * 60 * 1000 // 1 h — hard cap so a misconfigured client can't hoard sessions forever

function requireEmbedScope(
  headers: IncomingMessage['headers'],
): { ok: true; payload: JwtPayload } | { ok: false; status: number; code: string; message: string } {
  return requireScopeFromHeaders(headers, 'files:read')
}

/**
 * `POST /api/v1/embed/nonce`
 *
 * Mint a new handshake nonce session for `docId`. The returned `sessionId`
 * is the lookup key; the returned `nonce` is the value to put in the iframe
 * URL. They are equal in this implementation — the host SDK can pass either
 * one through `?nonce=...&sessionId=...` interchangeably.
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `400 BAD_REQUEST` (empty docId / out-of-range ttlMs),
 * `401 UNAUTHENTICATED`, `403 FORBIDDEN`
 * @public
 */
export async function handleEmbedNonce(ctx: {
  request: IncomingMessage
  response: ServerResponse
}): Promise<boolean> {
  const gate = requireEmbedScope(ctx.request.headers)
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'embed:nonce')
    return true
  }
  // §11.119: wrap JSON.parse in try/catch so malformed bodies surface as
  // 400 INVALID_ARGUMENT instead of leaking the raw SyntaxError as a 500.
  // Whitespace-only bodies are treated as "no body" (same convention as
  // §11.115/§11.116 null/undefined semantics).
  let body: Record<string, unknown> = {}
  try {
    const raw = await readBody(ctx.request)
    // `?? {}` collapses the `null` literal (valid JSON) into the empty
    // object so downstream `body.docId` / `body.sessionId` accesses
    // don't TypeError. String/number/boolean literals still pass
    // through and trigger field-validation 400 BAD_REQUEST downstream
    // — which is correct contract behavior, not a §11.119 leak.
    body = raw && raw.trim() ? ((JSON.parse(raw) as Record<string, unknown> | null) ?? {}) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'embed:nonce')
    return true
  }
  const docId = typeof body.docId === 'string' ? body.docId.trim() : ''
  if (!docId) {
    sendError(ctx.response, 400, 'docId required', 'BAD_REQUEST', 'embed:nonce')
    return true
  }
  let ttlMs = DEFAULT_TTL_MS
  if (body?.ttlMs !== undefined) {
    if (typeof body.ttlMs !== 'number' || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0) {
      sendError(ctx.response, 400, 'ttlMs must be a positive number', 'BAD_REQUEST', 'embed:nonce')
      return true
    }
    ttlMs = Math.min(MAX_TTL_MS, Math.floor(body.ttlMs))
  }
  const session = mintEmbedNonce(docId, ttlMs)
  if (!session) {
    sendError(ctx.response, 500, 'failed to mint session', 'INTERNAL', 'embed:nonce')
    return true
  }
  sendJson(ctx.response, 200, {
    sessionId: session.sessionId,
    nonce: session.nonce,
    expiresAt: session.expiresAt,
    ttlMs: session.expiresAt - session.mintedAt,
  })
  return true
}

/**
 * `POST /api/v1/embed/verify-nonce`
 *
 * Look up a previously-minted session and confirm the nonce matches.
 * Returns `{ valid: true, expiresAt }` when the session is live and the
 * nonces agree; otherwise `{ valid: false, reason }`.
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `400 BAD_REQUEST` (missing fields), `401 UNAUTHENTICATED`,
 * `403 FORBIDDEN`. A failed verification is NOT an error envelope — it
 * is a normal `200` response with `valid: false`. This is so the SDK can
 * branch cleanly without try/catch around the HTTP layer.
 * @public
 */
export async function handleEmbedVerifyNonce(ctx: {
  request: IncomingMessage
  response: ServerResponse
}): Promise<boolean> {
  const gate = requireEmbedScope(ctx.request.headers)
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'embed:verify-nonce')
    return true
  }
  // §11.119: wrap JSON.parse — see handleEmbedNonce for rationale.
  let body: Record<string, unknown> = {}
  try {
    const raw = await readBody(ctx.request)
    body = raw && raw.trim() ? ((JSON.parse(raw) as Record<string, unknown> | null) ?? {}) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'embed:verify-nonce')
    return true
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  const nonce = typeof body.nonce === 'string' ? body.nonce : ''
  if (!sessionId || !nonce) {
    sendError(ctx.response, 400, 'sessionId and nonce required', 'BAD_REQUEST', 'embed:verify-nonce')
    return true
  }
  const result = verifyEmbedNonce(sessionId, nonce)
  if (result.found) {
    sendJson(ctx.response, 200, { valid: true, expiresAt: result.session.expiresAt })
    return true
  }
  sendJson(ctx.response, 200, { valid: false, reason: result.reason })
  return true
}

/**
 * `DELETE /api/v1/embed/nonce`
 *
 * Forcefully evict a session from the server's nonce store. Used by the
 * host SDK when the iframe is torn down — releases the LRU slot
 * eagerly instead of waiting for the session to expire on its TTL.
 *
 * Body: `{ sessionId: string }`
 * Returns: `{ released: boolean }` — true if the session existed and
 * was removed; false if it was already gone (race with TTL / LRU).
 *
 * **Required scope**: `files:read`
 *
 * **Errors**: `400 BAD_REQUEST` (missing sessionId), `401 UNAUTHENTICATED`,
 * `403 FORBIDDEN`.
 *
 * Like `verify-nonce`, "session not found" is NOT an error envelope
 * — it returns `{ released: false }` so the SDK can call this
 * defensively from `destroy()` without try/catch around a known-race
 * scenario.
 * @public
 */
export async function handleEmbedReleaseNonce(ctx: {
  request: IncomingMessage
  response: ServerResponse
}): Promise<boolean> {
  const gate = requireEmbedScope(ctx.request.headers)
  if (!gate.ok) {
    sendError(ctx.response, gate.status, gate.message, gate.code, 'embed:release-nonce')
    return true
  }
  // §11.119: wrap JSON.parse — see handleEmbedNonce for rationale.
  let body: Record<string, unknown> = {}
  try {
    const raw = await readBody(ctx.request)
    body = raw && raw.trim() ? ((JSON.parse(raw) as Record<string, unknown> | null) ?? {}) : {}
  } catch {
    sendError(ctx.response, 400, 'invalid JSON body', 'INVALID_ARGUMENT', 'embed:release-nonce')
    return true
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (!sessionId) {
    sendError(ctx.response, 400, 'sessionId required', 'BAD_REQUEST', 'embed:release-nonce')
    return true
  }
  const released = removeEmbedNonce(sessionId)
  sendJson(ctx.response, 200, { released })
  return true
}
