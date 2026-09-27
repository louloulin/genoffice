/**
 * iframe Embed endpoint — `GET /embed/:docId?token=…&app=docs&theme=…&lang=…&toolbar=…`.
 *
 * Stable contract — sdk1.md §2.1.C. Third-party integrators drop a single
 * `<iframe src="https://genoffice.app/embed/doc_abc?token=…">` into their
 * page; the editor mounts itself with the supplied JWT, posts `{type:'ready'}`
 * to `window.parent`, and forwards its own lifecycle events from there.
 *
 * Implementation notes:
 *
 *   - The page is a server-rendered wrapper around the editor app's
 *     `index.html`. We resolve the editor bundle via the same renderer
 *     resolution that the SPA fallback uses, so the editor's existing
 *     router / IPC bootstrap runs unchanged.
 *
 *   - The JWT rides in a `<meta name="genoffice-token">` tag (same trick
 *     the SPA fallback uses for `WEB_TOKEN`) so the renderer's IPC
 *     transport can pick it up. The meta-tag form is the safest default —
 *     it doesn't require cookie cooperation.
 *
 *   - The injected `<script>` installs a postMessage bridge before the
 *     editor's own JS executes. It forwards outbound lifecycle events
 *     (`ready`, `saved`, `dirtyChanged`, `selectionChange`, `error`,
 *     `closed`) to `window.parent` via SSE relay. Inbound host
 *     commands are consumed by the editor's own postMessage listener
 *     registered after bridge boot; the bridge itself does not relay
 *     them (sdk1.md §11.34).
 *
 *   - The page returns a small `text/html` doc so embed consumers can
 *     see the editor loading state immediately; we deliberately do NOT
 *     `cache-control: public` so a token rotation propagates.
 * @public
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { verifyJwtDetailed } from '../api/v1/auth'
import { WEB_SERVER_VERSION } from '../common/version'
import { verifyEmbedNonce } from './nonce-store'
import { EMBED_BRIDGE_SOURCE } from './bridge'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS } from '../common/index'
import { authCookieHeader } from '../auth/cookie'


/**
 * Server-side validation of the embed `?token=` argument.
 *
 * The embed endpoint historically forwarded the token to the renderer via a
 * `<meta name="genoffice-token">` tag without verifying it server-side, so
 * any caller could fetch the wrapper HTML with an arbitrary (or empty)
 * token and rely on the renderer's own checks. With this helper the embed
 * endpoint gains true server-side enforcement:
 *
 *   - When `GENOFFICE_JWT_SECRET` is configured AND the supplied token has
 *     the three-segment JWT shape, the token is run through
 *     `verifyJwtWithRevocation`. A successful verify means a valid signature
 *     AND a fresh `jti` (the file JWT endpoint installs the revocation hook
 *     so one-time tokens are rejected on second use).
 *   - When the env var is missing (development without auth) or the token
 *     isn't JWT-shaped (e.g. legacy shared-secret mode), the helper returns
 *     `ok: true` and the page is served as before — backwards compatible.
 *
 * Returns one of:
 *   - `{ ok: true }` — proceed with HTML rendering
 *   - `{ ok: false, status, code, message }` — caller should 401/403 and stop
 */
function verifyEmbedToken(token: string):
  | { ok: true }
  | { ok: false; status: number; code: string; message: string } {
  const secret = process.env.GENOFFICE_JWT_SECRET ?? ''
  if (!secret) return { ok: true }
  // Only attempt JWT verification when the token has the 3-part shape;
  // legacy dev tokens (random strings, WEB_TOKEN shared secret) pass through.
  if (token.split('.').length !== 3) return { ok: true }
  // B.12: report the failure reason so the client can tell "expired, refresh
  // it" from "revoked, re-mint it" from "malformed, fix your token source".
  // A single "invalid or expired" left integrators guessing which of the
  // four possible causes they hit.
  const result = verifyJwtDetailed(token)
  if (!result.ok) {
    const codeByReason: Record<string, string> = {
      expired: 'EMBED_JWT_EXPIRED',
      revoked: 'EMBED_JWT_REVOKED',
      signature: 'EMBED_JWT_INVALID',
      malformed: 'EMBED_JWT_INVALID',
    }
    return {
      ok: false,
      status: 401,
      code: codeByReason[result.reason] ?? 'EMBED_JWT_INVALID',
      message: `embed token rejected: ${result.reason}`,
    }
  }
  // If the payload carries `files:read` scope it can render any doc; we
  // don't restrict by docId here because the SDK hands out file-scoped
  // tokens with `doc` set. Future hardening could match `payload.doc` to
  // the `:docId` path segment; deferred to a follow-up.
  return { ok: true }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const VALID_APPS = APPS as readonly string[]

interface EmbedQuery {
  token: string
  app: string
  mode: string | null
  theme: string | null
  lang: string | null
  toolbar: string | null
  title: string | null
  /**
   * Optional handshake nonce (URL-safe base64). When present the embed
   * bridge echoes it back in the `ready` postMessage event so the host
   * SDK can confirm the iframe is actually serving our document. Without
   * it the iframe's identity is not cryptographically attested — any
   * same-origin URL on the host's page could impersonate the editor.
   *
   * See sdk1.md §11.20.
   */
  nonce: string | null
  /**
   * Optional server-minted session id. When paired with `nonce`, the
   * embed handler looks up the LRU session to confirm the nonce matches.
   * This closes the §11.17.5 backlog: now every handshake is also
   * server-side validated, not just client-side echoed. See sdk1.md §11.27.
   */
  sessionId: string | null
}

function parseEmbedQuery(url: URL): EmbedQuery | { error: string } {
  const docIdRaw = url.pathname.replace(/^\/embed\//, '').split('/')[0] ?? ''
  // sdk1 §11.121: malformed percent-encoding (`/embed/%XY`, `/embed/%E0%A4%A`,
  // bare `%`) throws `URIError: URI malformed` from `decodeURIComponent`.
  // Without a try/catch the throw bubbles up to the top-level request handler,
  // becomes an unhandled rejection, and the HTTP response is never sent — the
  // client hangs until socket timeout. Mirror the §11.114 / §11.108 / §11.110
  // pattern (try/catch around the decode, return a structured 400 envelope)
  // so a malformed docId answers 400 INVALID_ARGUMENT in milliseconds instead
  // of silently dropping the request.
  let docId: string
  try {
    docId = decodeURIComponent(docIdRaw).trim()
  } catch {
    return { error: 'invalid percent-encoding in :docId' }
  }
  if (!docId) return { error: 'missing :docId in path' }
  const token = url.searchParams.get('token') ?? ''
  if (!token) return { error: 'missing ?token=' }
  const requestedApp = (url.searchParams.get('app') ?? 'docs').toLowerCase()
  const app = VALID_APPS.includes(requestedApp) ? requestedApp : 'docs'
  return {
    token,
    app,
    mode: url.searchParams.get('mode'),
    theme: url.searchParams.get('theme'),
    lang: url.searchParams.get('lang'),
    toolbar: url.searchParams.get('toolbar'),
    title: url.searchParams.get('title'),
    nonce: url.searchParams.get('nonce'),
    sessionId: url.searchParams.get('sessionId'),
  }
}

/**
 * Resolve the editor app's compiled `index.html`. Mirrors the SPA fallback
 * in `apps/web-server/src/index.ts` — both pull from the same renderer
 * output directory.
 */
function resolveAppIndex(app: string): string | null {
  const candidates = [
    resolve(__dirname, '..', '..', '..', app, 'dist', 'renderer', 'index.html'),
    resolve(__dirname, '..', '..', '..', app, 'dist', 'index.html'),
    resolve(__dirname, '..', '..', '..', app, 'build', 'renderer', 'index.html'),
    resolve(__dirname, '..', '..', '..', app, 'out', 'renderer', 'index.html'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * The bridge script injected into the embedded page. Kept compact so the
 * embed page renders instantly even on slow connections; the heavy editor
 * bundle loads afterwards. Apps that haven't yet shipped their own bridge
 * still trigger a `ready` event so SDK hosts can complete initialization.
 *
 * The bridge also subscribes to `/api/ipc/events?session=<sessionId>` so
 * server-side lifecycle events (saved / dirtyChanged / selectionChange /
 * error / closed) flow through to `window.parent`. The renderer's own
 * transport (createPushHub in the editor bundles) opens its own SSE
 * consumer on the same session; two parallel consumers is fine — the
 * server broadcasts to every connected socket in the session.
 */
const EMBED_BRIDGE_SOURCE_REEXPORT = EMBED_BRIDGE_SOURCE

/**
 * External bridge script — same source as `EMBED_BRIDGE_SOURCE` but served as
 * a separate file at `/embed/static/bridge.js` so the embed HTML can
 * reference it via `<script src=…>` instead of inlining it. The inline form
 * required `'unsafe-inline'` in the CSP `script-src` directive (the only
 * safe alternative was a nonce on the inline script, but every renderer
 * upgrade that touched the meta tag reset the nonce and broke the bridge).
 *
 * Loading the bridge from a same-origin URL removes the `unsafe-inline`
 * requirement entirely — the CSP only needs to allow `'self'` for scripts.
 * This is the "CSP tightening" piece of W6c.
 */
export const EMBED_BRIDGE_SCRIPT_PATH = '/embed/static/bridge.js'

/**
 * The same script, expressed *relative to the embed page's own directory*.
 *
 * The embed page is served at two different URLs depending on whether the host
 * mounts this server at the origin root or behind a path prefix:
 *
 *   root-mounted   /embed/<docId>
 *   prefixed       /office-engine/embed/<docId>   (proxy strips /office-engine)
 *
 * A reverse proxy erases the prefix before the request reaches us, so the
 * prefix cannot be recovered from `url.pathname` and must not be baked into
 * the HTML either. Referencing the bridge and the renderer bundle through the
 * embed page's own directory (`<base href="./">`) is the only form that
 * resolves correctly under both mountings: the browser then asks for
 * `<prefix>/embed/static/bridge.js`, the proxy strips its prefix, and the
 * request lands here as `/embed/static/bridge.js` — exactly the route below.
 */
export const EMBED_BRIDGE_SCRIPT_REF = EMBED_BRIDGE_SCRIPT_PATH.replace(/^\/embed\//, '')

/**
 * `frame-ancestors` value for the `/embed/:docId` HTML response (C.4).
 *
 * The embed page exists to be framed by a *different* origin — the
 * Dataflarework host — so `frame-ancestors 'none'` is not an option. But
 * omitting the directive entirely leaves the page frameable by *every*
 * origin, which is a UI-redressing (clickjacking) surface: an attacker page
 * can iframe the editor and overlay controls on top of it.
 *
 * Operators declare the hosts allowed to frame the editor:
 *
 *     EMBED_FRAME_ANCESTORS="'self' https://app.dataflarework.com"
 *
 * Defaults to `'self'` so an unconfigured deployment is closed by default.
 * Parsing is fail-closed: the value is split on whitespace/commas and every
 * token must match the strict pattern below, or the entire value is rejected
 * and `'self'` applies. Salvaging the valid tokens out of a malformed string
 * is what lets a splice attempt smuggle an origin that the operator never
 * wrote — e.g. `'self'; report-uri https://evil` contains a bare
 * `https://evil` token that would survive per-token filtering. Rejecting the
 * whole value keeps a hostile or fat-fingered config from ever widening the
 * policy. The pattern also excludes the characters (newline, `;`, quotes)
 * needed to terminate the header or start a new directive.
 *
 * `*` and `'none'` are honoured only when they are the *entire* value: both
 * are contradictory inside a list (`*` subsumes it; `'none'` is ignored by
 * CSP when other sources are present), so a stray one is dropped.
 */
const FRAME_ANCESTOR_TOKEN = /^(?:'self'|https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)$/

export function parseFrameAncestors(envValue: string | undefined): string {
  const fallback = "'self'"
  if (!envValue) return fallback
  const tokens = envValue
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return fallback
  if (tokens.length === 1 && (tokens[0] === '*' || tokens[0] === "'none'")) return tokens[0]
  if (!tokens.every((token) => FRAME_ANCESTOR_TOKEN.test(token))) return fallback
  return tokens.join(' ')
}

export const EMBED_FRAME_ANCESTORS: string = parseFrameAncestors(process.env.EMBED_FRAME_ANCESTORS)

/**
 * Build the embed HTML by reading the editor app's `index.html` and injecting
 * the bridge script + token meta tag right before `</head>`. We avoid
 * rewriting the body so the editor's existing bundle hashes don't drift.
 */
export function buildEmbedHtml(appIndexPath: string, q: EmbedQuery, docId: string): string {
  let html = readFileSync(appIndexPath, 'utf-8')
  // The bridge is now an external `<script src>` — no `'unsafe-inline'`
  // required. Two renderer-side quirks still need rewriting:
  //   1. The renderer's CSP meta tag declares `script-src 'self'`. We
  //      rewrite it to keep `frame-ancestors` semantics (none in a meta
  //      tag — that's an HTTP-header-only directive) and to make sure
  //      any non-self source the renderer had declared is dropped. Inline
  //      script tags in the renderer's own bundle should already carry a
  //      nonce/hash, so this rewrite is conservative.
  //   2. The renderer's bundle paths are relative (`./assets/index-XYZ.js`).
  //      They must resolve inside the embed directory, not at the origin
  //      root — see the `<base href="./">` note below, which also explains
  //      why the path prefix a reverse proxy mounts us under cannot be
  //      recovered here and must not be assumed to be `/`.
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
      (m) =>
        m
          // Drop any `'unsafe-inline'` / `'unsafe-eval'` so a re-scoped CSP
          // on the embed page can never silently relax back to "anything
          // goes". Inline scripts in the renderer's own bundle are out of
          // our control — they need to ship with their own nonce/hash.
          .replace(/\s*'unsafe-inline'/g, '')
          .replace(/\s*'unsafe-eval'/g, ''),
    )
  }
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    // Renderer shipped without a CSP meta tag — inject one. `script-src 'self'`
    // is enough now that the bridge lives in a separate file under our
    // origin. `connect-src` keeps localhost for dev, and `frame-ancestors`
    // is intentionally omitted — that's an HTTP-header directive only.
    html = html.replace(
      /<\/head>/i,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*">\n</head>`,
    )
  }
  // `<base href="./">` — the embed page's own directory, NOT the origin root.
  //
  // The renderer bundle references its assets relatively (`./assets/index-*.js`,
  // `./assets/index-*.css`). Resolving those against the origin root only works
  // when this server is mounted at `/`. Behind a path prefix — which is exactly
  // how Dataflarework runs it, `@RequestMapping("/office-engine")` with
  // `strip-path-prefix: true` — the browser asked the *host* for `/assets/…`,
  // a path the host never forwards, so the bundle 404'd and the embed iframe
  // rendered blank. The proxy strips the prefix upstream, so neither the
  // request URL nor any server-side state reveals the prefix; a root-relative
  // `<base>` is therefore wrong in the general case and a per-request guess is
  // impossible. Directory-relative is the one form that is correct under both
  // mountings, because it inherits whatever prefix the iframe URL already has.
  //
  // `<base>` only affects URLs that follow it, so inject it as the first
  // element after `<head>` opens.
  const baseTag = '<base href="./">'
  html = html.replace(/<head>/i, (_m) => `<head>\n${baseTag}`)
  const safeToken = q.token.replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const tokenTag = `\n<meta name="genoffice-token" content="${safeToken}">`
  // Mirror the optional handshake nonce so the renderer bridge can echo it
  // back in the `ready` postMessage event. Escaped the same way as the
  // token. See sdk1.md §11.20.
  const safeNonce = q.nonce
    ? q.nonce.replace(/"/g, '&quot;').replace(/</g, '&lt;')
    : null
  const nonceTag = safeNonce ? `\n<meta name="genoffice-nonce" content="${safeNonce}">` : ''
  // Per-request sessionId for the embed iframe's SSE push channel. The bridge
  // opens /api/ipc/events?session=<id> and forwards every frame to window.parent.
  const sessionId = `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const embedConfig = {
    docId,
    app: q.app,
    mode: q.mode ?? 'edit',
    theme: q.theme ?? 'auto',
    lang: q.lang ?? 'en-US',
    toolbar: q.toolbar ?? 'full',
    title: q.title ?? null,
    sessionId,
  }
  const configTag = `\n<meta name="genoffice-embed-config" content="${escapeAttr(JSON.stringify(embedConfig))}">`
  const sessionTag = `\n<meta name="genoffice-session" content="${sessionId}">`
  // Bridge is loaded from a same-origin file — no inline `<script>`, no
  // `'unsafe-inline'` requirement in the CSP. Referenced relative to the embed
  // directory (see `EMBED_BRIDGE_SCRIPT_REF`) so it survives a path-prefixed
  // mount; a root-relative `/embed/static/bridge.js` would ask the *host* for
  // that path, which the host does not forward.
  const bridgeTag = `\n<script src="${EMBED_BRIDGE_SCRIPT_REF}"></script>`
  const injection = tokenTag + nonceTag + configTag + sessionTag + bridgeTag
  // Case-insensitive match against `</head>` so a renderer with a `<HEAD>`
  // tag (rare but possible after build minification) still gets the bridge
  // injected. Without the `/i` flag a strict HTML renderer with an uppercase
  // HEAD slipped past and produced a blank embed page.
  return html.replace(/<\/head>/i, (_match) => `${injection}</head>`)
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Wire the embed endpoint into the web-server request handler.
 *
 * Return value:
 *   - `true` if the request matched `/embed/...` and was answered
 *   - `false` if the path doesn't match (caller falls through to SPA)
 * @public
 */
export function handleEmbed(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (!url.pathname.startsWith('/embed/')) return false

  // `/embed/assets/**` is the renderer's own bundle, not an embed-document
  // request. It arrives here because the embed HTML resolves its relative
  // assets against the embed directory (`<base href="./">`), which is what
  // makes the page survive a path-prefixed mount. Falling through to the
  // static layer matters: without this, `parseEmbedQuery` below treats
  // `assets` as the app name and answers 400 `missing ?token=`, which the
  // browser reports as a MIME failure and the iframe renders blank.
  if (url.pathname.startsWith('/embed/assets/')) return false

  // `/embed/static/bridge.js` — external bridge script. The embed HTML now
  // references it via `<script src="…">` instead of an inline `<script>`,
  // so the CSP can stay at `script-src 'self'` (no `'unsafe-inline'`).
  // Returns the script with a long-lived cache header — the bridge changes
  // are bundled with a server release, not per request.
  if (url.pathname === EMBED_BRIDGE_SCRIPT_PATH) {
    if (request.method !== 'GET') {
      response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required', allow: 'GET' },
      }))
      return true
    }
    response.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    })
    response.end(EMBED_BRIDGE_SOURCE)
    return true
  }

  // sdk1 §11.109: only GET is documented; POST / PUT / DELETE fall
  // through to the SPA fallback (200 + index.html) which looks like
  // a successful render. Return 405 with the structured envelope.
  if (request.method !== 'GET') {
    response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'GET required',
        channel: url.pathname,
        allow: 'GET',
      },
    }))
    return true
  }

  const parsed = parseEmbedQuery(url)
  if ('error' in parsed) {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ error: { message: parsed.error, code: 'INVALID_ARGUMENT' } }))
    return true
  }

  // Server-side token gate. Skipped when GENOFFICE_JWT_SECRET is unset
  // (legacy dev mode) or when the token isn't JWT-shaped. When activated,
  // a one-time token from /api/v1/files/:id/jwt?oneTime=true is rejected
  // on second view — the hook installed in api/v1/files.ts is now live.
  const tokenCheck = verifyEmbedToken(parsed.token)
  if (!tokenCheck.ok) {
    response.writeHead(tokenCheck.status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: {
        message: tokenCheck.message,
        code: tokenCheck.code,
      },
    }))
    return true
  }

  // Optional server-side nonce session binding (sdk1.md §11.27). When
  // the host supplied a sessionId, confirm the URL nonce matches the
  // server-minted one. Absent sessionId keeps the legacy client-only
  // check from §11.20 — backwards compatible.
  if (parsed.sessionId) {
    if (!parsed.nonce) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        error: {
          message: 'sessionId present without nonce',
          code: 'INVALID_ARGUMENT',
        },
      }))
      return true
    }
    const session = verifyEmbedNonce(parsed.sessionId, parsed.nonce)
    if (!session.found) {
      response.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({
        error: {
          message: `nonce session ${session.reason}`,
          code: 'NONCE_SESSION_INVALID',
        },
      }))
      return true
    }
  }

  // sdk1 §11.121 (continuation): the same safe-decode is needed here, AFTER
  // the parseEmbedQuery() gate has already consumed the same segment. If
  // `parseEmbedQuery` returned an `error` we returned 400 above, but if the
  // path was clean we still need to re-decode for the `appIndex` lookup —
  // and any decode failure here must yield the same 400 envelope rather
  // than crashing the request. The second decode is technically redundant
  // (parseEmbedQuery already decoded), so on the happy path it returns the
  // same string; on the malformed-encoding path it now returns a clean 400
  // instead of an unhandled rejection.
  let docId: string
  try {
    docId = decodeURIComponent(url.pathname.replace(/^\/embed\//, '').split('/')[0] ?? '')
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: {
        message: 'invalid percent-encoding in :docId',
        code: 'INVALID_ARGUMENT',
      },
    }))
    return true
  }
  const appIndex = resolveAppIndex(parsed.app)
  if (!appIndex) {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({
      error: {
        message: `editor app "${parsed.app}" is not built. Run pnpm --filter @genoffice/${parsed.app} build first.`,
        code: 'EMBED_APP_NOT_BUILT',
      },
    }))
    return true
  }

  const html = buildEmbedHtml(appIndex, parsed, docId)
  // Mirror the WEB_TOKEN shim used by the static SPA fallback (index.ts:1208):
  // under WEB_TOKEN mode, the iframe's /api/ipc/* calls would 401 because the
  // bridge has no way to learn the token (it can't carry custom headers on
  // EventSource, and the SDK transport is same-origin). Setting the cookie on
  // this HTML response lets the browser auto-attach it to every same-origin
  // request. Safe because (a) the cookie is HttpOnly + SameSite=Strict so an
  // XSS in the iframe can't exfiltrate it, and (b) only callers who already
  // know WEB_TOKEN benefit — the auth gate still rejects requests whose
  // cookie doesn't match.
  const cookie = authCookieHeader()
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    // C.4: header-only directive (a `<meta>` CSP cannot carry
    // `frame-ancestors`), so it has to be set here rather than in the
    // renderer's meta tag. Emitted as its own policy — the response has no
    // other CSP header, and multiple CSP headers intersect, so this can only
    // ever narrow what the renderer's meta tag already allows.
    'Content-Security-Policy': `frame-ancestors ${EMBED_FRAME_ANCESTORS}`,
    ...(cookie ? { 'Set-Cookie': cookie } : {}),
  })
  response.end(html)
  return true
}

export { EMBED_BRIDGE_SOURCE_REEXPORT as EMBED_BRIDGE } // re-export for backwards compat (test consumers may import)
