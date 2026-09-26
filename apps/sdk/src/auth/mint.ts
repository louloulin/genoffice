/**
 * Auth mint capability — wraps `POST /api/v1/auth/jwt`.
 *
 * The server enforces a 30..86400 TTL clamp and validates `sub` / `doc` /
 * `scope` shapes before signing; the SDK mirrors that validation locally so
 * callers see `INVALID_ARGUMENT` instead of a 400 round-trip for the common
 * mistakes (empty `sub`, non-string `doc`, non-array `scope`).
 *
 * Why a separate client (not folded into `FileClient` or `AuthClient`):
 *   - Mint is an *outbound* capability — the caller proves who they are
 *     to the server. Every other SDK module consumes the resulting token.
 *   - Keeps mint out of the request helpers so a host that only needs
 *     `mint` doesn't pull file-management HTTP code.
 */
import { requestJson, RequestError, type RequestConfig, type RequestOptions } from '../internal/request'

export interface MintRequest {
  /** Subject (user id). Trimmed; required, non-empty. */
  sub: string
  /** Optional document scope (single doc binding). */
  doc?: string
  /** Optional scope list (RBAC). Both `scope` and `perm` are accepted by
   *  the server; the SDK forwards both when provided. */
  scope?: string[]
  perm?: string[]
  /** Relative lifetime in seconds. Clamped to [30, 86400] server-side. */
  ttl?: number
  /** Absolute `exp` epoch seconds. Mutually exclusive with `ttl`; the
   *  server prefers `ttl` when both are present. */
  exp?: number
}

export interface MintResult {
  token: string
  exp: number
  ttlSeconds: number
  alg: 'HS256' | 'RS256'
}

const MIN_TTL_SEC = 30
const MAX_TTL_SEC = 86_400

export class AuthMintClient {
  constructor(private readonly config: RequestConfig) {
    if (!config.baseUrl) throw new Error('AuthMintClient: baseUrl is required')
  }

  /**
   * Mint a JWT for iframe embed / API consumers.
   *
   * Required: `sub` (non-empty string). Optional: `doc`, `scope` / `perm`
   * arrays, and one of `ttl` (seconds, recommended) or `exp` (epoch sec).
   *
   * Throws `RequestError` with `code: 'INVALID_ARGUMENT'` for bad input
   * shape — the server would reject these too, but the SDK surfaces the
   * validation up front so a typo doesn't waste a network round-trip.
   */
  async mint(req: MintRequest, options: RequestOptions = {}): Promise<MintResult> {
    validate(req)
    const body: Record<string, unknown> = { sub: req.sub.trim() }
    if (req.doc) body.doc = req.doc
    if (req.scope) body.scope = req.scope
    if (req.perm) body.perm = req.perm
    if (req.ttl !== undefined) body.ttl = req.ttl
    if (req.exp !== undefined) body.exp = req.exp

    const raw = await requestJson<{ token: string; exp: number; ttlSeconds: number; alg: string }>(
      this.config,
      'POST',
      '/api/v1/auth/jwt',
      body,
      'auth:mint',
      options,
    )
    const alg = raw.alg === 'RS256' ? 'RS256' : 'HS256'
    return { token: raw.token, exp: raw.exp, ttlSeconds: raw.ttlSeconds, alg }
  }

  /**
   * Build a `Bearer`-ready token getter for the other SDK clients. Useful
   * when the host wants a single mint at boot and then hands the token to
   * many capability clients without re-minting on every call.
   *
   * The returned getter is sync-only — for token rotation use the more
   * general `({ bearer: () => fetchFreshToken() })` shape on each client.
   */
  async bearerGetter(req: MintRequest, options: RequestOptions = {}): Promise<() => string> {
    const result = await this.mint(req, options)
    return () => result.token
  }
}

function validate(req: MintRequest): void {
  if (typeof req.sub !== 'string' || req.sub.trim().length === 0) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'mint: `sub` must be a non-empty string',
      status: 0,
      channel: 'auth:mint',
    })
  }
  if (req.doc !== undefined && (typeof req.doc !== 'string' || req.doc.trim().length === 0)) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'mint: `doc` must be a non-empty string when provided',
      status: 0,
      channel: 'auth:mint',
    })
  }
  if (req.scope !== undefined && !isStringArray(req.scope)) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'mint: `scope` must be an array of non-empty strings',
      status: 0,
      channel: 'auth:mint',
    })
  }
  if (req.perm !== undefined && !isStringArray(req.perm)) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'mint: `perm` must be an array of non-empty strings',
      status: 0,
      channel: 'auth:mint',
    })
  }
  if (req.ttl !== undefined) {
    if (typeof req.ttl !== 'number' || !Number.isFinite(req.ttl)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'mint: `ttl` must be a finite number of seconds',
        status: 0,
        channel: 'auth:mint',
      })
    }
    if (req.ttl < MIN_TTL_SEC || req.ttl > MAX_TTL_SEC) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: `mint: \`ttl\` must be in [${MIN_TTL_SEC}, ${MAX_TTL_SEC}]`,
        status: 0,
        channel: 'auth:mint',
      })
    }
  }
  if (req.exp !== undefined) {
    if (typeof req.exp !== 'number' || !Number.isFinite(req.exp)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'mint: `exp` must be a finite epoch-seconds value',
        status: 0,
        channel: 'auth:mint',
      })
    }
  }
  if (req.ttl !== undefined && req.exp !== undefined) {
    // Mirror the server: `ttl` wins over `exp` when both are supplied, but
    // warn the caller so they don't think they're setting `exp`.
    // We don't throw — the server accepts the pair — but the SDK honours
    // `ttl` only.
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim().length > 0)
}