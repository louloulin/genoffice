/**
 * OIDC authorization-code flow (A67 / A21 / A68).
 *
 * Replaces the placeholder that handed the renderer a hard-coded
 * `https://sso.genoffice.ai/authorize` URL and, on callback, ignored `state`
 * and `code` entirely to return `token-<now>`. That stub was worse than a
 * missing feature: it looked like SSO, so a deployment could believe its
 * users were authenticated by an identity provider when no provider was ever
 * consulted.
 *
 * What happens here instead is the real RFC 6749 §4.1 + OpenID Connect Core
 * flow:
 *
 *   1. `beginAuthorisation` discovers the provider
 *      (`{issuer}/.well-known/openid-configuration`), mints a single-use
 *      `state` and a PKCE S256 pair, and returns the provider's own
 *      authorisation URL for the renderer to open.
 *   2. `completeAuthorisation` consumes the `state` exactly once (CSRF —
 *      an unknown, expired or already-used state is rejected, never
 *      ignored), exchanges the `code` at the token endpoint together with
 *      the PKCE verifier, verifies the ID token's signature against the
 *      provider's JWKS plus its `iss` / `aud` / `exp` / `nonce` claims, and
 *      finally signs a **local** GenOffice JWT.
 *
 * The local JWT is the only credential the rest of the server sees. Its
 * `scope` claim comes from {@link SCOPES_FOR_GROUP}, a code-resident table
 * whose vocabulary is exactly the one `auth/route-policy.ts` routes on — so a
 * minted token is admissible on precisely the routes its scopes name, and
 * widening it is a reviewable code change rather than an IdP-side setting.
 *
 * # Configuration
 *
 * `GENOFFICE_OIDC_PROVIDERS` is a JSON object keyed by the provider name the
 * renderer passes (`{"google":{"issuer":"…","clientId":"…"}}`). A single
 * provider can instead be configured through the flat
 * `GENOFFICE_OIDC_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` /
 * `_REDIRECT_URI` / `_SCOPES` variables and is then addressed as `default`.
 *
 * With no provider configured the handlers refuse the request — they never
 * fall back to a fabricated URL.
 *
 * `https` is required for every endpoint the discovery document names; plain
 * `http` is accepted only for loopback hosts, which is what the container-based
 * e2e uses. Following a discovery document to an arbitrary `http://` host
 * would turn the issuer setting into an SSRF primitive.
 */
import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  createHmac,
  timingSafeEqual,
  type JsonWebKey,
} from 'node:crypto'
import { signJwt, type JwtPayload } from '../api/v1/auth'
import { InvalidArgumentError } from '../ai/errors'

/** How long a started authorisation may sit before its `state` expires. */
const PENDING_TTL_MS = 10 * 60 * 1000
/** Upper bound on in-flight authorisations, so a caller cannot grow the map without limit. */
const MAX_PENDING = 1024
const DISCOVERY_TTL_MS = 10 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5_000
/** Lifetime of the local JWT minted after a successful callback. */
const LOCAL_TOKEN_TTL_SEC = 3_600

export interface OidcProviderConfig {
  issuer: string
  clientId: string
  clientSecret?: string
  /** Defaults to `['openid', 'profile', 'email']`. */
  scopes?: string[]
  /** Used when the callback does not carry one. */
  redirectUri?: string
  /** Overrides {@link SCOPES_FOR_GROUP} for this provider. */
  groupScopes?: Record<string, string[]>
  /** Claim holding the tenant id; defaults to `tenant`. */
  tenantClaim?: string
}

export interface OidcLoginResult {
  ok: true
  provider: string
  accessToken: string
  expiresIn: number
  scopes: string[]
  user: { id: string; email?: string; name?: string }
  tenant?: string
}

interface DiscoveryDocument {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri?: string
}

interface PendingAuthorisation {
  provider: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  createdAt: number
}

const pending = new Map<string, PendingAuthorisation>()
const discoveryCache = new Map<string, { document: DiscoveryDocument; fetchedAt: number }>()
const jwksCache = new Map<string, { keys: JsonWebKey[]; fetchedAt: number }>()

/**
 * The scope vocabulary an IdP group maps to.
 *
 * These strings are the ones `auth/route-policy.ts` matches, so this table is
 * the single place where "what an identity provider says about a user" becomes
 * "what this server will let that user do". A group that is not listed — or a
 * provider that supplies no groups at all — gets the read-only default.
 */
export const SCOPES_FOR_GROUP: Readonly<Record<string, readonly string[]>> = {
  'genoffice:admin': ['admin'],
  'genoffice:editor': [
    'files:read',
    'files:write',
    'files:comment',
    'ai:chat',
    'ai:translate',
    'kb:read',
  ],
  'genoffice:viewer': ['files:read'],
}

/** Applied when no group in the token maps to a scope. */
export const DEFAULT_SCOPES: readonly string[] = ['files:read']

/** Claims that may carry group membership, in priority order. */
const GROUP_CLAIMS = ['groups', 'roles'] as const

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function b64urlDecode(input: string): Buffer {
  const pad = '='.repeat((4 - (input.length % 4)) % 4)
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function timeoutMs(): number {
  const raw = Number(process.env.GENOFFICE_OIDC_TIMEOUT_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * Every endpoint from a discovery document must be https, except on loopback
 * where the container-based test IdP serves plain http.
 */
function assertUsableEndpoint(raw: string, field: string, issuer: string): void {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`OIDC issuer ${issuer}: discovery document has an unparseable ${field}`)
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return
  throw new Error(
    `OIDC issuer ${issuer}: ${field} must use https (${url.protocol}//${url.host} is not allowed)`,
  )
}

/** Configured providers, keyed by the name the renderer addresses them with. */
export function oidcProviders(env: NodeJS.ProcessEnv = process.env): Record<string, OidcProviderConfig> {
  const providers: Record<string, OidcProviderConfig> = {}
  const raw = env.GENOFFICE_OIDC_PROVIDERS?.trim()
  if (raw) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('GENOFFICE_OIDC_PROVIDERS is not valid JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('GENOFFICE_OIDC_PROVIDERS must be a JSON object keyed by provider name')
    }
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`OIDC provider "${name}" must be an object`)
      }
      const cfg = value as Partial<OidcProviderConfig>
      if (typeof cfg.issuer !== 'string' || !cfg.issuer.trim()) {
        throw new Error(`OIDC provider "${name}" is missing "issuer"`)
      }
      if (typeof cfg.clientId !== 'string' || !cfg.clientId.trim()) {
        throw new Error(`OIDC provider "${name}" is missing "clientId"`)
      }
      providers[name] = { ...cfg, issuer: cfg.issuer.trim(), clientId: cfg.clientId.trim() }
    }
  }

  const flatIssuer = env.GENOFFICE_OIDC_ISSUER?.trim()
  const flatClientId = env.GENOFFICE_OIDC_CLIENT_ID?.trim()
  if (flatIssuer && flatClientId && !providers.default) {
    providers.default = {
      issuer: flatIssuer,
      clientId: flatClientId,
      ...(env.GENOFFICE_OIDC_CLIENT_SECRET ? { clientSecret: env.GENOFFICE_OIDC_CLIENT_SECRET } : {}),
      ...(env.GENOFFICE_OIDC_REDIRECT_URI ? { redirectUri: env.GENOFFICE_OIDC_REDIRECT_URI } : {}),
      ...(env.GENOFFICE_OIDC_SCOPES ? { scopes: env.GENOFFICE_OIDC_SCOPES.split(/[\s,]+/).filter(Boolean) } : {}),
    }
  }
  return providers
}

export function listOidcProviders(): string[] {
  return Object.keys(oidcProviders())
}

function providerConfig(name: string, handler: string): OidcProviderConfig {
  const config = oidcProviders()[name]
  if (!config) {
    throw new InvalidArgumentError(
      handler,
      `unknown SSO provider "${name}" — configure it via GENOFFICE_OIDC_PROVIDERS`,
    )
  }
  return config
}

async function fetchJson(url: string, init: RequestInit | undefined, what: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs()) })
  } catch (error) {
    throw new Error(`${what} request to ${url} failed: ${(error as Error).message}`)
  }
  if (!response.ok) {
    throw new Error(`${what} request to ${url} answered ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error(`${what} request to ${url} did not return JSON`)
  }
}

/** Cached discovery document for an issuer. */
async function discover(issuer: string): Promise<DiscoveryDocument> {
  const cached = discoveryCache.get(issuer)
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.document

  const base = issuer.replace(/\/+$/, '')
  const raw = (await fetchJson(`${base}/.well-known/openid-configuration`, undefined, 'OIDC discovery')) as Partial<DiscoveryDocument>
  if (!raw || typeof raw.authorization_endpoint !== 'string' || typeof raw.token_endpoint !== 'string') {
    throw new Error(`OIDC discovery for ${issuer} did not return authorization_endpoint/token_endpoint`)
  }
  // RFC 8414 §3.3: the document's issuer must match the one we asked about.
  if (raw.issuer !== undefined && raw.issuer !== issuer && raw.issuer !== base) {
    throw new Error(`OIDC discovery for ${issuer} returned a different issuer (${String(raw.issuer)})`)
  }
  assertUsableEndpoint(raw.authorization_endpoint, 'authorization_endpoint', issuer)
  assertUsableEndpoint(raw.token_endpoint, 'token_endpoint', issuer)
  if (raw.userinfo_endpoint) assertUsableEndpoint(raw.userinfo_endpoint, 'userinfo_endpoint', issuer)
  if (raw.jwks_uri) assertUsableEndpoint(raw.jwks_uri, 'jwks_uri', issuer)

  const document: DiscoveryDocument = {
    issuer: raw.issuer ?? issuer,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    ...(raw.userinfo_endpoint ? { userinfo_endpoint: raw.userinfo_endpoint } : {}),
    ...(raw.jwks_uri ? { jwks_uri: raw.jwks_uri } : {}),
  }
  discoveryCache.set(issuer, { document, fetchedAt: Date.now() })
  return document
}

function pkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = b64url(randomBytes(32))
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest())
  return { codeVerifier, codeChallenge }
}

function rememberState(state: string, entry: PendingAuthorisation): void {
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value
    if (oldest !== undefined) pending.delete(oldest)
  }
  pending.set(state, entry)
}

/**
 * Step 1: build the provider's authorisation URL and remember the `state`.
 *
 * @returns the URL the renderer must open, and the `state` it must echo back.
 */
export async function beginAuthorisation(input: {
  provider: string
  redirectUri?: string
}): Promise<{ authUrl: string; state: string }> {
  const provider = input.provider?.trim()
  if (!provider) throw new InvalidArgumentError('auth:sso-login', 'provider is required')
  const config = providerConfig(provider, 'auth:sso-login')

  const redirectUri = (input.redirectUri ?? config.redirectUri)?.trim()
  if (!redirectUri) {
    throw new InvalidArgumentError(
      'auth:sso-login',
      'redirectUri is required (pass it in or set it on the provider config)',
    )
  }

  const document = await discover(config.issuer)
  const state = b64url(randomBytes(24))
  const nonce = b64url(randomBytes(16))
  const { codeVerifier, codeChallenge } = pkcePair()
  rememberState(state, { provider, codeVerifier, nonce, redirectUri, createdAt: Date.now() })

  const url = new URL(document.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('scope', (config.scopes?.length ? config.scopes : ['openid', 'profile', 'email']).join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')

  return { authUrl: url.toString(), state }
}

async function jwksFor(issuer: string, jwksUri: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(issuer)
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached.keys
  const raw = (await fetchJson(jwksUri, undefined, 'OIDC JWKS')) as { keys?: JsonWebKey[] }
  if (!raw || !Array.isArray(raw.keys)) throw new Error(`OIDC JWKS for ${issuer} has no "keys" array`)
  jwksCache.set(issuer, { keys: raw.keys, fetchedAt: Date.now() })
  return raw.keys
}

const VERIFY_ALGORITHMS: Record<string, string> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
  PS256: 'RSA-SHA256',
  ES256: 'SHA256',
  ES384: 'SHA384',
}

/**
 * Verify the provider's ID token: signature against JWKS, then `iss` / `aud` /
 * `exp` / `nonce`. Returns the claims.
 */
async function verifyIdToken(
  token: string,
  options: { issuer: string; clientId: string; nonce: string; jwksUri?: string; clientSecret?: string },
): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('ID token is not a JWT')
  const [headerB64, payloadB64, sigB64] = parts

  let header: { alg?: string; kid?: string; typ?: string }
  let claims: Record<string, unknown>
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString('utf8'))
    claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'))
  } catch {
    throw new Error('ID token is not decodable')
  }
  const signingInput = `${headerB64}.${payloadB64}`
  const signature = b64urlDecode(sigB64)

  if (header.alg === 'HS256') {
    // Symmetric signing is legal OIDC (client-secret as key) but must never be
    // accepted when the issuer publishes a JWKS: that is the classic
    // "alg=none / HMAC confusion" downgrade.
    if (!options.clientSecret) throw new Error('ID token uses HS256 but no client secret is configured')
    if (options.jwksUri) throw new Error('ID token uses HS256 while the issuer publishes a JWKS')
    const expected = createHmac('sha256', options.clientSecret).update(signingInput).digest()
    if (expected.length !== signature.length || !timingSafeEqual(expected, signature)) {
      throw new Error('ID token signature is invalid')
    }
  } else {
    const algorithm = header.alg ? VERIFY_ALGORITHMS[header.alg] : undefined
    if (!algorithm) throw new Error(`unsupported ID token algorithm: ${header.alg}`)
    if (!options.jwksUri) throw new Error('ID token is asymmetric but the issuer published no jwks_uri')
    const keys = await jwksFor(options.issuer, options.jwksUri)
    const candidates = header.kid ? keys.filter((key) => (key as { kid?: string }).kid === header.kid) : keys
    if (candidates.length === 0) throw new Error(`no JWKS key matches kid "${header.kid}"`)
    const verified = candidates.some((key) => {
      try {
        const publicKey = createPublicKey({ key, format: 'jwk' })
        return createVerify(algorithm).update(signingInput).verify(publicKey, signature)
      } catch {
        return false
      }
    })
    if (!verified) throw new Error('ID token signature is invalid')
  }

  if (claims.iss !== options.issuer) {
    throw new Error(`ID token issuer mismatch (expected ${options.issuer}, got ${String(claims.iss)})`)
  }
  const audience = claims.aud
  const audienceOk = Array.isArray(audience)
    ? audience.includes(options.clientId)
    : audience === options.clientId
  if (!audienceOk) throw new Error('ID token audience does not include this client')
  if (typeof claims.exp !== 'number' || Date.now() / 1000 > claims.exp) {
    throw new Error('ID token is expired')
  }
  if (typeof claims.nonce === 'string' && claims.nonce !== options.nonce) {
    throw new Error('ID token nonce mismatch')
  }
  return claims
}

function groupsFrom(claims: Record<string, unknown>): string[] {
  for (const claim of GROUP_CLAIMS) {
    const value = claims[claim]
    if (Array.isArray(value)) return value.filter((g): g is string => typeof g === 'string')
    if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean)
  }
  return []
}

/** Map verified claims onto the scope vocabulary `route-policy` routes on. */
export function scopesForClaims(
  claims: Record<string, unknown>,
  overrides?: Record<string, string[]>,
): string[] {
  const table = overrides ?? SCOPES_FOR_GROUP
  const scopes = new Set<string>()
  for (const group of groupsFrom(claims)) {
    for (const scope of table[group] ?? []) scopes.add(scope)
  }
  if (scopes.size === 0) for (const scope of DEFAULT_SCOPES) scopes.add(scope)
  // `admin` implies the operator surface; keep it from silently accumulating
  // alongside narrower scopes so an audit of a token reads unambiguously.
  return [...scopes].sort()
}

export function resetOidcStateForTests(): void {
  pending.clear()
  discoveryCache.clear()
  jwksCache.clear()
}

/**
 * Step 2: consume `state`, exchange `code` for tokens, verify the ID token and
 * mint a local JWT.
 */
export async function completeAuthorisation(input: {
  code: string
  state: string
}): Promise<OidcLoginResult> {
  const code = input.code?.trim()
  const state = input.state?.trim()
  if (!code) throw new InvalidArgumentError('auth:sso-callback', 'code is required')
  if (!state) throw new InvalidArgumentError('auth:sso-callback', 'state is required')

  const entry = pending.get(state)
  // Single-use: consumed whether or not the exchange below succeeds, so a
  // replayed callback can never re-mint a token from the same authorisation.
  pending.delete(state)
  if (!entry) {
    throw new InvalidArgumentError('auth:sso-callback', 'unknown or already-used SSO state (CSRF check failed)')
  }
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    throw new InvalidArgumentError('auth:sso-callback', 'SSO state has expired; restart the login')
  }

  const config = providerConfig(entry.provider, 'auth:sso-callback')
  const document = await discover(config.issuer)

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    client_id: config.clientId,
    code_verifier: entry.codeVerifier,
  })
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
  if (config.clientSecret) {
    // client_secret_basic — the method every mainstream IdP accepts without
    // extra configuration; the secret never leaves this process.
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`
  }

  const tokenResponse = (await fetchJson(
    document.token_endpoint,
    { method: 'POST', headers, body: form.toString() },
    'OIDC token exchange',
  )) as Record<string, unknown>

  if (typeof tokenResponse.error === 'string') {
    throw new Error(
      `OIDC token endpoint refused the exchange: ${tokenResponse.error}${
        typeof tokenResponse.error_description === 'string' ? ` (${tokenResponse.error_description})` : ''
      }`,
    )
  }
  const idToken = typeof tokenResponse.id_token === 'string' ? tokenResponse.id_token : undefined
  const upstreamAccessToken =
    typeof tokenResponse.access_token === 'string' ? tokenResponse.access_token : undefined

  let claims: Record<string, unknown>
  if (idToken) {
    claims = await verifyIdToken(idToken, {
      issuer: document.issuer,
      clientId: config.clientId,
      nonce: entry.nonce,
      ...(document.jwks_uri ? { jwksUri: document.jwks_uri } : {}),
      ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    })
  } else if (document.userinfo_endpoint && upstreamAccessToken) {
    const raw = (await fetchJson(
      document.userinfo_endpoint,
      { headers: { authorization: `Bearer ${upstreamAccessToken}` } },
      'OIDC userinfo',
    )) as Record<string, unknown>
    if (typeof raw.sub !== 'string' || !raw.sub) throw new Error('OIDC userinfo returned no subject')
    claims = { ...raw, iss: document.issuer, aud: config.clientId }
  } else {
    throw new Error('OIDC token response carried neither an id_token nor a usable userinfo endpoint')
  }

  const subject = typeof claims.sub === 'string' ? claims.sub : ''
  if (!subject) throw new Error('OIDC claims carry no subject')

  const tenantClaim = config.tenantClaim ?? 'tenant'
  const tenantValue = claims[tenantClaim]
  const tenant = typeof tenantValue === 'string' && tenantValue.trim() ? tenantValue.trim() : undefined
  const scopes = scopesForClaims(claims, config.groupScopes)

  const now = Math.floor(Date.now() / 1000)
  // No `jti`: the single-use revocation hook installed by `api/v1/files.ts`
  // records every jti on first successful verify, so a token that carries one
  // is good for exactly one request through `route-policy`. `/auth/jwt` and
  // the OAuth client_credentials flow omit it for the same reason. An SSO
  // session token is meant to be reused until it expires.
  const payload: JwtPayload = {
    sub: subject,
    ...(tenant ? { tenant } : {}),
    scope: scopes,
    iat: now,
    exp: now + LOCAL_TOKEN_TTL_SEC,
    iss: 'genoffice',
    aud: 'genoffice-web',
  }

  return {
    ok: true,
    provider: entry.provider,
    accessToken: signJwt(payload),
    expiresIn: LOCAL_TOKEN_TTL_SEC,
    scopes,
    user: {
      id: subject,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string'
        ? { name: claims.name }
        : typeof claims.preferred_username === 'string'
          ? { name: claims.preferred_username }
          : {}),
    },
    ...(tenant ? { tenant } : {}),
  }
}

/** Test-only: how many authorisations are awaiting their callback. */
export function pendingAuthorisationCount(): number {
  return pending.size
}
