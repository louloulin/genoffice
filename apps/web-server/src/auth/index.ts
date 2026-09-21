/**
 * Static-token auth gate for the web-server IPC surface.
 *
 * Default posture: open. Setting `WEB_TOKEN` activates the gate for
 * every `/api/*` request except the small public allowlist below. This
 * mirrors the legacy Dataflare bridge behaviour (cookie-based, but the
 * shape is the same: prove who you are on every call that touches the
 * host).
 *
 * Token transport:
 *
 *   Authorization: Bearer <token>
 *   X-GenOffice-Token: <token>
 *
 * The custom header exists because some browsers strip `Authorization`
 * on cross-origin EventSource requests (which is what
 * `/api/ai/translate/stream` and `/api/ipc/events` are).
 *
 * Failure shape: a 401 with a `WWW-Authenticate: Bearer` challenge and
 * a structured JSON body so the renderer can show a real error instead
 * of a generic "IPC failed".
 *
 * With `WEB_TOKEN` unset the server stays open. That keeps local dev,
 * e2e tests, and the desktop preload (which already has an
 * OS-level trust boundary) working without ceremony. Production
 * deployments that want the gate should set `WEB_TOKEN` AND `HOST` to
 * something other than loopback.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

export interface AuthorisedRequest {
  headers: IncomingMessage['headers']
}

const PUBLIC_API_PATHS = new Set<string>([
  '/health',
  '/api/channels',
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
