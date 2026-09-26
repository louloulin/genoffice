/**
 * `createAuthedClient` — pick the right bearer for the web-server's
 * dual-auth model and return a factory the SDK capability clients can
 * plug in as their `bearer` getter.
 *
 * Why this exists (plan §6.1 B.1): third-party hosts routinely miss one
 * of the two auth gates. `WEB_TOKEN` (env-gated shared secret) is
 * accepted via `Authorization`, `X-GenOffice-Token`, cookie, or query.
 * The JWT-with-scope model is enforced per-request. A caller who ships
 * a JWT without `WEB_TOKEN` in dev gets a 401, and vice versa.
 *
 * Usage:
 *
 *   const auth = await createAuthedClient({
 *     baseUrl: 'https://office.example/api',
 *     webToken: process.env.WEB_TOKEN,         // optional
 *     mint:     { sub: 'host-app', scope: ['files:read'] },
 *     fetch:    globalThis.fetch,
 *   })
 *   const files = new FileClient({ baseUrl: 'https://office.example', bearer: auth.bearer })
 *
 * The returned `bearer` getter is synchronous (caches the token after
 * first mint). Call `auth.refresh()` to re-mint after rotation.
 */
import { AuthMintClient, type MintRequest, type MintResult } from './mint'

export interface CreateAuthedClientOptions {
  baseUrl: string
  /**
   * Static shared secret matching the server's `WEB_TOKEN` env. When set,
   * the SDK uses it directly and skips the mint step.
   */
  webToken?: string | null
  /**
   * Mint parameters — required unless `webToken` is provided. The mint
   * is performed once at boot; the resulting JWT is cached in memory.
   */
  mint?: MintRequest
  /** Optional fetch override (tests, custom transports). */
  fetch?: typeof fetch
  /**
   * Override the TTL the SDK asks the server to mint at boot. Defaults
   * to the server-side default (3600s). Token is re-minted only when
   * `auth.refresh()` is called, so size this for your session length.
   */
  ttlSeconds?: number
}

export interface AuthedClient {
  /** True when using the static WEB_TOKEN; false when using a minted JWT. */
  readonly mode: 'web-token' | 'jwt'
  /** Synchronous bearer getter — drop into any SDK capability client. */
  readonly bearer: () => string
  /** Re-mint the JWT (no-op in `web-token` mode). Returns the new token. */
  refresh(): Promise<string>
  /** Returns the original mint result so callers can read `exp` / `alg`. */
  readonly last: MintResult | null
}

export async function createAuthedClient(opts: CreateAuthedClientOptions): Promise<AuthedClient> {
  if (!opts.baseUrl) throw new Error('createAuthedClient: baseUrl is required')

  // Mode 1 — WEB_TOKEN: no mint needed, the env secret IS the bearer.
  if (typeof opts.webToken === 'string' && opts.webToken.length > 0) {
    const token = opts.webToken
    return {
      mode: 'web-token',
      bearer: () => token,
      refresh: async () => token,
      last: null,
    }
  }

  // Mode 2 — JWT: mint at boot, cache the result.
  if (!opts.mint) {
    throw new Error('createAuthedClient: either `webToken` or `mint` is required')
  }
  const client = new AuthMintClient({ baseUrl: opts.baseUrl, fetch: opts.fetch })
  const initial = await client.mint({
    ...opts.mint,
    ...(opts.ttlSeconds !== undefined ? { ttl: opts.ttlSeconds } : {}),
  })
  let current: MintResult = initial
  return {
    mode: 'jwt',
    bearer: () => current.token,
    async refresh() {
      current = await client.mint({
        ...opts.mint!,
        ...(opts.ttlSeconds !== undefined ? { ttl: opts.ttlSeconds } : {}),
      })
      return current.token
    },
    get last() {
      return current
    },
  }
}