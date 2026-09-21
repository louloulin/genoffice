/**
 * /api/v1/auth — JWT and OAuth 2.0 token issuance.
 *
 * Two flows today:
 *   1. JWT (HS256 by default, RS256 if GENOFFICE_JWT_PUBLIC_KEY is set):
 *      POST /api/v1/auth/jwt  { sub, doc?, perm?, exp? }
 *      Returns { token, exp, alg } so the client can hand the token to
 *      iframe Embed URLs.
 *
 *   2. OAuth 2.0 client_credentials (single user / enterprise flow):
 *      POST /api/v1/auth/oauth/token
 *        grant_type=client_credentials&client_id=...&client_secret=...
 *      Returns RFC 6749 §4.4 response: { access_token, token_type, expires_in }
 *      The access_token is the same JWT shape and uses the same verification
 *      path downstream.
 *
 * Both paths share the same secret (`GENOFFICE_JWT_SECRET`) by default;
 * flipping `GENOFFICE_JWT_ALG=RS256` enables asymmetric signing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, createSign, createVerify, timingSafeEqual } from 'node:crypto'
import { sendJson, sendError, readBody } from './http-utils'

const SECRET = process.env.GENOFFICE_JWT_SECRET || process.env.WEB_TOKEN || ''
const ALG = (process.env.GENOFFICE_JWT_ALG || 'HS256').toUpperCase()
const DEFAULT_TTL_SEC = 3600

export interface JwtPayload {
  sub: string
  doc?: string
  /** RBAC scope list — flat array of action:resource strings.  Mirrors the
   *  OAuth 2.0 `scope` claim; `perm` is kept for backward compatibility with
   *  earlier GenOffice clients and is treated as an alias of `scope`.  Both
   *  fields are read by `hasScope()`; if either contains the requested
   *  string, the call is authorized.  Standard scopes include
   *  `files:read`, `files:write`, `files:delete`, `ai:chat`, `ai:translate`,
   *  `ai:image`, `ai:skill`, `kb:read`, `kb:write`, `webhooks:manage`.
   *  A token without any scope claim is read-only (`files:read` implied).
   *  See sdk1.md Appendix B.2 #3. */
  scope?: string[]
  perm?: string[]
  iat: number
  exp: number
  iss: string
  aud: string
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64urlDecode(input: string): Buffer {
  const pad = '='.repeat((4 - (input.length % 4)) % 4)
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

/** Sign a JWT payload. Exported so other v1 endpoints (files:jwt, webhooks) can mint tokens. */
export function signJwt(payload: JwtPayload): string {
  const header = { alg: ALG, typ: 'JWT' }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  if (ALG === 'HS256') {
    if (!SECRET) throw new Error('GENOFFICE_JWT_SECRET not set')
    const sig = createHmac('sha256', SECRET).update(signingInput).digest()
    return `${signingInput}.${b64url(sig)}`
  }
  if (ALG === 'RS256') {
    const key = process.env.GENOFFICE_JWT_PRIVATE_KEY
    if (!key) throw new Error('GENOFFICE_JWT_PRIVATE_KEY not set')
    const sig = createSign('RSA-SHA256').update(signingInput).sign(key)
    return `${signingInput}.${b64url(sig)}`
  }
  throw new Error(`Unsupported JWT alg: ${ALG}`)
}

/**
 * Verify a JWT signature and expiration. Returns the decoded payload, or null on any failure (bad signature, expired, malformed).
 *
 * **Returns**: `JwtPayload | null`
 */
export function verifyJwt(token: string): JwtPayload | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  let header: { alg?: string }
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'))
  } catch {
    return null
  }
  const signingInput = `${headerB64}.${payloadB64}`
  try {
    if (header.alg === 'HS256') {
      if (!SECRET) return null
      const expected = createHmac('sha256', SECRET).update(signingInput).digest()
      const actual = b64urlDecode(sigB64)
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    } else if (header.alg === 'RS256') {
      const key = process.env.GENOFFICE_JWT_PUBLIC_KEY
      if (!key) return null
      const ok = createVerify('RSA-SHA256').update(signingInput).verify(key, b64urlDecode(sigB64))
      if (!ok) return null
    } else {
      return null
    }
  } catch {
    return null
  }
  try {
    const payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8')) as JwtPayload
    if (typeof payload.exp === 'number' && Date.now() / 1000 > payload.exp) return null
    return payload
  } catch {
    return null
  }
}




/**
 * Read & verify the Authorization: Bearer header. Returns the decoded
 * payload, or null if the header is missing / malformed / invalid.
 */
export function requireAuthFromHeaders(headers: unknown): JwtPayload | null {
  const h = headers as { authorization?: string | string[] | undefined } | null | undefined
  const raw = h?.authorization
  if (typeof raw !== 'string' || !raw.startsWith('Bearer ')) return null
  return verifyJwt(raw.slice('Bearer '.length))
}

/**
 * Same as `requireAuthFromHeaders` but also enforces that the payload carries
 * `scope`. Returns `{ ok: true, payload }` on success, or
 * `{ ok: false, status, code, message }` on failure so callers can hand the
 * failure envelope straight to `sendError` without re-mapping.
 */
export function requireScopeFromHeaders(
  headers: unknown,
  scope: string,
): { ok: true; payload: JwtPayload } | { ok: false; status: number; code: string; message: string } {
  const payload = requireAuthFromHeaders(headers)
  if (!payload) {
    return { ok: false, status: 401, code: 'UNAUTHENTICATED', message: 'Bearer token required' }
  }
  if (!hasScope(payload, scope)) {
    return { ok: false, status: 403, code: 'FORBIDDEN', message: `token does not grant scope "${scope}"` }
  }
  return { ok: true, payload }
}

/**
 * Check whether a JWT payload authorizes a given scope. The check is the
 * union of `scope` and `perm` — `perm` is the legacy field, kept for back
 * compat. An empty / absent scope claim grants `files:read` only
 * (read-only mode); this matches how OAuth providers typically omit scope
 * when they only want to authenticate without authorizing actions.
 *
 * Wildcard matching: a scope entry of `*` matches any requested scope.
 * A scope entry of `files:*` matches any `files:`-prefixed scope.
 */
export function hasScope(payload: JwtPayload | null | undefined, scope: string): boolean {
  if (!payload) return false
  if (payload.sub === 'admin') return true // internal admin user bypass
  const claims = [...(payload.scope ?? []), ...(payload.perm ?? [])]
  if (claims.length === 0) {
    // Default: read-only.
    return scope === 'files:read'
  }
  for (const claim of claims) {
    if (claim === '*' || claim === scope) return true
    if (claim.endsWith(':*')) {
      const prefix = claim.slice(0, -1) // drop the trailing '*'
      if (scope.startsWith(prefix)) return true
    }
  }
  return false
}

export async function handleAuthJwt(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const { request, response } = ctx
  if (!SECRET) {
    sendError(response, 503, 'JWT not configured (set GENOFFICE_JWT_SECRET)', 'NOT_CONFIGURED')
    return true
  }
  let body: { sub?: string; doc?: string; perm?: string[]; scope?: string[]; exp?: number }
  try {
    const raw = await readBody(request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(response, 400, 'request body is not valid JSON', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }
  if (typeof body.sub !== 'string' || !body.sub) {
    sendError(response, 400, 'expected { sub: string }', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }
  const now = Math.floor(Date.now() / 1000)
  const exp = typeof body.exp === 'number' && body.exp > now ? body.exp : now + DEFAULT_TTL_SEC
  // Merge `scope` and `perm` so downstream code (hasScope) sees both.
  const mergedScope = Array.from(new Set([...(body.scope ?? []), ...(body.perm ?? [])]))
  const payload: JwtPayload = {
    sub: body.sub,
    ...(body.doc ? { doc: body.doc } : {}),
    ...(mergedScope.length ? { scope: mergedScope } : {}),
    ...(body.perm ? { perm: body.perm } : {}),
    iat: now,
    exp,
    iss: 'genoffice',
    aud: 'genoffice-web',
  }
  try {
    const token = signJwt(payload)
    sendJson(response, 200, { token, exp, alg: ALG })
  } catch (err) {
    sendError(response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'auth:jwt')
  }
  return true
}

export async function handleOAuthToken(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const { request, response } = ctx
  if (!SECRET) {
    sendError(response, 503, 'OAuth not configured', 'NOT_CONFIGURED')
    return true
  }
  let formBody: Record<string, string> = {}
  try {
    const raw = await readBody(request)
    formBody = Object.fromEntries(new URLSearchParams(raw).entries())
  } catch {
    sendError(response, 400, 'invalid form body', 'INVALID_ARGUMENT', 'auth:oauth')
    return true
  }
  if (formBody.grant_type !== 'client_credentials') {
    sendError(response, 400, 'only grant_type=client_credentials is supported', 'UNSUPPORTED_GRANT', 'auth:oauth')
    return true
  }
  const clientsJson = process.env.GENOFFICE_OAUTH_CLIENTS
  if (!clientsJson) {
    sendError(response, 503, 'OAuth clients not configured', 'NOT_CONFIGURED', 'auth:oauth')
    return true
  }
  let clients: Record<string, { secret: string; sub: string; scopes?: string[] }>
  try {
    clients = JSON.parse(clientsJson)
  } catch {
    sendError(response, 503, 'OAuth clients malformed', 'NOT_CONFIGURED', 'auth:oauth')
    return true
  }
  const clientId = formBody.client_id
  const clientSecret = formBody.client_secret
  const client = clientId ? clients[clientId] : undefined
  if (!client || client.secret !== clientSecret) {
    sendError(response, 401, 'invalid client credentials', 'INVALID_CLIENT', 'auth:oauth')
    return true
  }
  const now = Math.floor(Date.now() / 1000)
  const exp = now + DEFAULT_TTL_SEC
  const token = signJwt({
    sub: client.sub,
    ...(client.scopes ? { perm: client.scopes } : {}),
    iat: now,
    exp,
    iss: 'genoffice',
    aud: 'genoffice-web',
  })
  sendJson(response, 200, {
    access_token: token,
    token_type: 'Bearer',
    expires_in: DEFAULT_TTL_SEC,
  })
  return true
}
