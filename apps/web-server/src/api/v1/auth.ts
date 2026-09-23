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
 * @public
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
  /** Optional unique token id (RFC 7519 §4.1.7). Used to support
   *  single-use file JWTs — the embed endpoint records the jti in a
   *  process-local revocation set on first use so subsequent requests
   *  with the same token answer 401 TOKEN_REVOKED. */
  jti?: string
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
 * Optional revocation-list hook used by `verifyJwt`. Defaults to a
 * no-op so existing callers keep working. The file JWT endpoint
 * installs a revocation check that records each `jti` on first verify
 * and rejects second uses; other token kinds (the global `/auth/jwt`
 * issuance, OAuth client_credentials) opt out by leaving the default.
 */
export type JtiRevocationCheck = (jti: string) => boolean

let jtiRevocationHook: JtiRevocationCheck = () => false

export function setJtiRevocationCheck(fn: JtiRevocationCheck): void {
  jtiRevocationHook = fn
}

export function isJtiRevoked(jti: string): boolean {
  return jtiRevocationHook(jti)
}

/**
 * Admin JWT revocation registry (§11.79). Distinct from the file-scoped
 * single-use JTI revocation that `files.ts` installs via
 * `setJtiRevocationCheck`: that store auto-revokes each JTI on first
 * verify (LRU 200k). This registry is the *manual* admin surface —
 * `auth:revoke-jti` adds a JTI here, `auth:list-revoked-jtis` reads it.
 * Both stores are honoured by `verifyJwtWithRevocation` so a token whose
 * JTI is on either list is rejected.
 *
 * The registry keeps insertion order so `listRevokedJtis()` returns
 * a deterministic, oldest-first view. Capacity cap matches the file
 * revocation store; once exceeded, the oldest entry is evicted to
 * bound memory.
 */
const ADMIN_MAX_REVOCATIONS = 200_000
const adminRevokedJtis = new Set<string>()
const adminRevocationOrder: string[] = []

export function revokeJti(jti: string): boolean {
  if (typeof jti !== 'string' || jti.length === 0) return false
  if (adminRevokedJtis.has(jti)) return false
  adminRevokedJtis.add(jti)
  adminRevocationOrder.push(jti)
  while (adminRevocationOrder.length > ADMIN_MAX_REVOCATIONS) {
    const oldest = adminRevocationOrder.shift()
    if (oldest) adminRevokedJtis.delete(oldest)
  }
  return true
}

export function listRevokedJtis(): string[] {
  return [...adminRevocationOrder]
}

/** Test-only reset; mirrors `_resetFileJwtState()` in files.ts. */
export function _resetAdminJwtRevocationForTests(): void {
  adminRevokedJtis.clear()
  adminRevocationOrder.length = 0
}


/**
 * Verify a JWT with the revocation check layered on top of `verifyJwt`.
 * Returns the decoded payload, or null on revocation / signature /
 * expiry failures. Use this entrypoint from any handler that consumes
 * a token which may carry a `jti` (embed iframe, file-scoped tokens).
 */
export function verifyJwtWithRevocation(token: string): JwtPayload | null {
  const payload = verifyJwt(token)
  if (!payload) return null
  if (payload.jti) {
    if (jtiRevocationHook(payload.jti)) return null
    // Admin revocation registry (§11.79): a JTI explicitly revoked via
    // `auth:revoke-jti` invalidates the token even before the file-scoped
    // hook fires. The two stores are independent.
    if (adminRevokedJtis.has(payload.jti)) return null
  }
  return payload
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
  // Internal admin user bypass (matches the pre-existing convention).
  // sdk1 §11.106: also honor the literal scope `admin` so hosts that
  // follow the documented convention (`scope: ['admin']` for full access)
  // don't get 403 on every admin-only endpoint. `*` continues to work
  // as a wildcard; `admin` is a synonym specifically because the
  // v1 docs (`comments.ts:13`, `ai.ts:38`, etc.) all advertise
  // `scope: 'admin'` as the admin bypass — previously the docstring
  // and implementation were out of sync and hosts that followed the
  // docs got 403 on admin endpoints.
  if (payload.sub === 'admin') return true
  // sdk1 §11.115: filter to strings before matching. A token minted before
  // the §11.115 validation landed (or one hand-crafted with a non-string
  // claim) could carry `scope: [1,2,3]`; the old `claim.endsWith(...)` call
  // then threw `claim.endsWith is not a function`, turning every scoped
  // request into a 500. A non-string claim is meaningless to the matcher,
  // so drop it — this is a *deny* (the claim grants nothing), never an
  // accidental grant.
  const claims = [...(payload.scope ?? []), ...(payload.perm ?? [])].filter(
    (c): c is string => typeof c === 'string',
  )
  if (claims.includes('admin')) return true
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

/** Max lifetime a caller may request via `ttl` (seconds). Tokens whose
 *  requested TTL exceeds this are clamped rather than rejected — matches
 *  the `ttlMs` clamp the embed-nonce endpoint uses (sdk1 §11.26). The
 *  default is a day; no host legitimately needs a longer-lived bearer
 *  token, and a longer TTL only widens the blast radius of a leaked one. */
const MAX_TTL_SEC = 86_400 // 24 h
/** Min lifetime a caller may request. Sub-second / zero / negative TTLs
 *  are clamped up so a host can never mint an already-dead or eternal
 *  token by accident. */
const MIN_TTL_SEC = 30

/**
 * Mint a short-lived JWT for iframe embed / API consumers.
 *
 * @route POST /api/v1/auth/jwt
 * @summary (see above)
 * @scope ai:* / files:* / kb:* / webhooks:* / admin
 * @errors INVALID_ARGUMENT / UNAUTHORIZED / INTERNAL
 * @public
 */
export async function handleAuthJwt(ctx: { request: IncomingMessage; response: ServerResponse }): Promise<boolean> {
  const { request, response } = ctx
  if (!SECRET) {
    sendError(response, 503, 'JWT not configured (set GENOFFICE_JWT_SECRET)', 'NOT_CONFIGURED')
    return true
  }
  // Accept `ttl` (documented in docs/api/rest-api.md) as well as the
  // legacy `exp` (absolute epoch-seconds). Unknown extra fields are
  // allowed but never trusted.
  let body: { sub?: unknown; doc?: unknown; perm?: unknown; scope?: unknown; exp?: unknown; ttl?: unknown }
  try {
    const raw = await readBody(request)
    body = raw ? JSON.parse(raw) : {}
  } catch {
    sendError(response, 400, 'request body is not valid JSON', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }
  // sdk1 §11.106: also reject whitespace-only sub. Previously the
  // check `!body.sub` only rejected empty string; `"   "` (3 spaces)
  // was accepted and the resulting JWT had a meaningless sub claim,
  // which would surface as `"   "` in audit logs / event subscribers.
  if (typeof body.sub !== 'string' || body.sub.trim().length === 0) {
    sendError(response, 400, 'expected non-empty { sub: string }', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }
  const sub = body.sub.trim()

  // sdk1 §11.115 bug A: `doc`, when present, MUST be a non-empty string.
  // The old code did `...(body.doc ? { doc: body.doc } : {})` with no type
  // check, so `{ doc: 123 }` (a number) was signed verbatim into the token,
  // producing a spec-violating JWT whose `doc` claim is a number — any
  // downstream consumer comparing `payload.doc === id` misbehaves. Reject
  // non-string / whitespace-only values rather than silently signing them.
  // `null` is treated as "field not set" (JSON idiom) rather than an error.
  const docArg = body.doc ?? undefined
  if (docArg !== undefined) {
    if (typeof docArg !== 'string' || docArg.trim().length === 0) {
      sendError(response, 400, 'doc must be a non-empty string when provided', 'INVALID_ARGUMENT', 'auth:jwt')
      return true
    }
  }

  // sdk1 §11.115 bug B: `scope` / `perm` MUST be arrays of non-empty
  // strings. The old code spread them directly (`...body.scope`), which:
  //   - threw `(body.scope ?? []) is not iterable` (an opaque 500) when a
  //     caller sent a string / number / object instead of an array;
  //   - and silently split a bare string into its characters
  //     (`"admin"` → `['a','d','m','i','n']`), producing a token whose
  //     scope is garbage yet still passes the `typeof x === 'string'` shape
  //     check downstream.
  // Both are caller errors → 400 with the standard envelope.
  const scopeArg = body.scope ?? undefined
  const permArg = body.perm ?? undefined
  if (scopeArg !== undefined && !isStringArray(scopeArg)) {
    sendError(response, 400, 'scope must be an array of non-empty strings', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }
  if (permArg !== undefined && !isStringArray(permArg)) {
    sendError(response, 400, 'perm must be an array of non-empty strings', 'INVALID_ARGUMENT', 'auth:jwt')
    return true
  }

  const now = Math.floor(Date.now() / 1000)
  // sdk1 §11.115 bug C: lifetime resolution. Precedence is
  // `ttl` (relative seconds, documented) over `exp` (legacy absolute).
  // Whichever is supplied is clamped to [MIN_TTL_SEC, MAX_TTL_SEC] so we
  // can never mint (a) an already-expired token, (b) a token whose `exp`
  // JSON-serialises to `null` (the old `exp: 1e999` path — `JSON.stringify(
  // Infinity)` is `null`, and `verifyJwt` only checks `typeof exp ===
  // 'number'`, so a `null` exp token was effectively immortal), or (c) a
  // token living longer than MAX_TTL_SEC.
  let exp = now + DEFAULT_TTL_SEC
  const ttlArg = body.ttl ?? undefined
  const expArg = body.exp ?? undefined
  if (ttlArg !== undefined || expArg !== undefined) {
    const requested = ttlArg !== undefined ? ttlArg : expArg
    const n = Number(requested)
    if (!Number.isFinite(n)) {
      // `Number.isFinite` is false for Infinity / -Infinity / NaN. A
      // non-finite lifetime can never be signed safely (`JSON.stringify(
      // Infinity)` is `null`, which `verifyJwt` treats as no-expiry).
      sendError(response, 400, 'ttl must be a finite number of seconds', 'INVALID_ARGUMENT', 'auth:jwt')
      return true
    }
    // `ttl` is relative; `exp` is absolute epoch-seconds (legacy).
    const requestedExp = ttlArg !== undefined ? now + Math.floor(n) : Math.floor(n)
    const ttl = requestedExp - now
    const clamped = Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, ttl))
    exp = now + clamped
  }

  // Merge `scope` and `perm` so downstream code (hasScope) sees both.
  const mergedScope = Array.from(
    new Set([...((scopeArg as string[] | undefined) ?? []), ...((permArg as string[] | undefined) ?? [])]),
  )
  const payload: JwtPayload = {
    sub,
    ...(docArg ? { doc: docArg } : {}),
    ...(mergedScope.length ? { scope: mergedScope } : {}),
    ...(permArg ? { perm: permArg as string[] } : {}),
    iat: now,
    exp,
    iss: 'genoffice',
    aud: 'genoffice-web',
  }
  try {
    const token = signJwt(payload)
    sendJson(response, 200, { token, exp, ttlSeconds: exp - now, alg: ALG })
  } catch (err) {
    sendError(response, 500, err instanceof Error ? err.message : String(err), 'INTERNAL', 'auth:jwt')
  }
  return true
}

/** True when `v` is an array of one-or-more non-empty trimmed strings. */
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0)
}

/**
 * OAuth 2.0 client_credentials grant (RFC 6749 §4.4).
 *
 * @route POST /api/v1/auth/oauth/token
 * @summary (see above)
 * @scope —
 * @errors INVALID_ARGUMENT / UNAUTHORIZED
 * @public
 */
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
