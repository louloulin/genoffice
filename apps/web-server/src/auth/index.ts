/**
 * Static-token auth gate for the web-server IPC surface.
 *
 * # Dual-auth model
 *
 * Two independent gates protect the IPC surface. A request must satisfy
 * **both** for `/api/v1/*` and the IPC bridge; HTML previews and a small
 * allowlist bypass them.
 *
 * ## Gate 1 — `WEB_TOKEN` (env-gated shared secret)
 *
 * - Default posture: **open**. `WEB_TOKEN` unset = no gate.
 * - When set: every `/api/*` request (except the public allowlist) must
 *   present the secret. The secret is the same in every transport:
 *     - `Authorization: Bearer <token>`
 *     - `X-GenOffice-Token: <token>` (used by EventSource, which strips
 *       `Authorization` cross-origin)
 *     - `Cookie: auth_token=<token>` (HttpOnly, set on first HTML response
 *       to a WEB_TOKEN-configured boot — every editor bundle is
 *       authenticated without per-bundle plumbing)
 *     - `?token=<token>` query param (non-browser clients, curl, older
 *       EventSource paths)
 *
 * ## Gate 2 — JWT + scope (per-request)
 *
 * - Independent of `WEB_TOKEN`. A request that has the env secret but no
 *   `Authorization: Bearer <jwt>` falls through to the IPC handler, which
 *   then enforces its own scope check (`requireScopeFromHeaders`).
 * - JWT signing keys: `GENOFFICE_JWT_SECRET` (HS256, default) or
 *   `GENOFFICE_JWT_ALG=RS256` with the matching public/private pair.
 * - TTL clamp: 30..86400 seconds. Sub-second / out-of-range TTLs are
 *   clamped up / down rather than rejected so a typo can't mint an
 *   eternal token.
 * - Scope list: flat `action:resource` strings; `*` and `action:*` are
 *   wildcards. Empty / absent `scope` is read-only (`files:read`).
 *
 * # Third-party integration
 *
 * The SDK ships `createAuthedClient()` (`apps/sdk/src/auth/client.ts`) to
 * pick the right transport automatically:
 *
 *   - If `process.env.WEB_TOKEN` (or a passed-in `webToken`) is set, the
 *     returned client uses it as a Bearer for every request.
 *   - Otherwise, the returned client calls `AuthMintClient.mint(...)` on
 *     boot and forwards the resulting JWT as Bearer.
 *
 * Without this helper, third-party hosts routinely miss one of the two
 * gates and see a 401 with no actionable error — see plan §6.1 B.1.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface AuthorisedRequest {
  headers: IncomingMessage['headers']
}

const PUBLIC_API_PATHS = new Set<string>([
  '/health',
  '/api/channels',
  '/api/v1/health',
  '/api/v1/changelog',
])

const PUBLIC_API_PREFIXES = [
  '/api/html/preview/', // HTML preview is anonymous by design — read-only pixels
]

export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_PATHS.has(pathname)) return true
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}

function readToken(headers: IncomingMessage['headers'], url?: { searchParams?: { get(name: string): string | null } }): string | null {
  const raw = process.env.WEB_TOKEN
  if (!raw || raw.length === 0) return null
  // Authorisation header — case-insensitive prefix match.
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match && match[1] === raw) return raw
  }
  // Legacy custom header — used by EventSource transports that strip
  // Authorization on cross-origin.
  const custom = headers['x-genoffice-token']
  if (typeof custom === 'string' && custom === raw) return raw
  // HttpOnly cookie set on the first HTML response. Browsers auto-send
  // this on every same-origin request — including EventSource, which
  // cannot carry custom headers — so every editor bundle (pdf/docs/
  // sheets/slides/markdown/html) and the shell authenticate without any
  // per-bundle plumbing. The cookie value is only accepted when it
  // matches the env-supplied secret, so a forged cookie is just another
  // 401. We only ever set one cookie (auth_token) and only when serving
  // HTML to a WEB_TOKEN-configured boot (apps/web-server/src/index.ts).
  const cookieHeader = headers.cookie
  if (typeof cookieHeader === 'string') {
    const match = /(?:^|;\s*)auth_token=([^;\s]+)/.exec(cookieHeader)
    if (match && decodeURIComponent(match[1]) === raw) return raw
  }
  // Query parameter — kept as a fallback for non-browser clients (curl,
  // SDK consumers, EventSource from older code paths). Same-origin page
  // loads still prefer the cookie path.
  if (url?.searchParams) {
    const q = url.searchParams.get('token')
    if (typeof q === 'string' && q === raw) return raw
  }
  return null
}

export function isAuthorised(request: AuthorisedRequest & { url?: { searchParams?: { get(name: string): string | null } } }): boolean {
  const expected = process.env.WEB_TOKEN
  if (!expected || expected.length === 0) return true
  return readToken(request.headers, request.url) === expected
}

export function writeUnauthorized(response: ServerResponse, message: string): void {
  response.writeHead(401, {
    'Content-Type': 'application/json',
    'WWW-Authenticate': 'Bearer realm="genoffice-web-server"',
  })
  response.end(
    JSON.stringify({
      error: {
        code: 'UNAUTHORIZED',
        message,
      },
    }),
  )
}
