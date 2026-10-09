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
import { EMBED_BRIDGE_SOURCE, EMBED_BRIDGE_SCRIPT_PATH } from './bridge'
import { resolve } from 'node:path'
import { APPS } from '../common/index'
import { STATIC_ROOT } from '../common/paths'
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
 *   - `{ ok: true, verified: true }`  — the token passed JWT verification here
 *   - `{ ok: true, verified: false }` — legacy pass-through: no secret
 *     configured, or the token isn't JWT-shaped. The page is served, but the
 *     caller must NOT treat this token as an authenticated credential.
 *   - `{ ok: false, status, code, message }` — caller should 401/403 and stop
 *
 * `verified` exists so the cookie site can tell "the caller proved possession
 * of a signed token" from "the caller typed something". Only the former may be
 * echoed back as an iframe credential.
 */
function verifyEmbedToken(token: string):
  | { ok: true; verified: boolean }
  | { ok: false; status: number; code: string; message: string } {
  const secret = process.env.GENOFFICE_JWT_SECRET ?? ''
  if (!secret) return { ok: true, verified: false }
  // Only attempt JWT verification when the token has the 3-part shape;
  // legacy dev tokens (random strings, WEB_TOKEN shared secret) pass through.
  if (token.split('.').length !== 3) return { ok: true, verified: false }
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
  return { ok: true, verified: true }
}

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
  /**
   * Where the host wants the AI chat panel: `left` | `right` | `floating`.
   * Passed through verbatim (null when absent) and validated in the renderer by
   * `isAiPanelPlacement` — an unrecognised value is simply ignored there.
   */
  aiPanel: string | null
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
    aiPanel: url.searchParams.get('aiPanel'),
  }
}

/**
 * Resolve the editor app's compiled `index.html`, off the same `STATIC_ROOT`
 * the SPA fallback (`apps/web-server/src/index.ts`) serves `/docs/` from.
 *
 * This used to walk up from `__dirname` three levels and probe four candidate
 * layouts. That walk is only correct in the monorepo, where the bundle sits at
 * `apps/web-server/dist/bundle` — three levels below `apps/`. The Docker image
 * flattens it to `/app/bundle`, so the walk resolved to `/docs/out/renderer/…`
 * and every embed answered 503 `EMBED_APP_NOT_BUILT` while `/docs/` answered
 * 200 from the same bytes. Same defect class as the operator-mount path ladder:
 * a location derived from the source tree rather than pinned by ENV.
 *
 * `STATIC_ROOT` is `WEB_STATIC_ROOT` when set, and `runStartupChecks()` refuses
 * to boot unless `<app>/out/renderer/index.html` exists under it for every app —
 * so there is exactly one layout to look for, and a miss here means the startup
 * check was bypassed.
 */
function resolveAppIndex(app: string): string | null {
  const candidate = resolve(STATIC_ROOT, app, 'out', 'renderer', 'index.html')
  return existsSync(candidate) ? candidate : null
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
 *
 * The path constant lives in `./bridge` because the bridge source interpolates
 * it to resolve its own URL at runtime; re-exported here for the endpoints and
 * tests that have always imported it from this module.
 */
export { EMBED_BRIDGE_SCRIPT_PATH }

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
 * Re-scope a renderer-shipped CSP `content` value.
 *
 * 只动 `script-src`：把其中的 `'unsafe-inline'` / `'unsafe-eval'` 摘掉，让渲染器
 * 自带的 meta CSP 不可能悄悄退化成「什么都行」。内联脚本要跑就得自己带 nonce/hash。
 *
 * **曾经这里是全局 replace，于是它是一个纯粹的 bug。** 四个渲染器
 * （docs / sheets / slides / pdf）随包发出来的都是
 * `style-src 'self' 'unsafe-inline'`，而那句 `.replace(/\s*'unsafe-inline'/g, '')`
 * 不带作用域地作用于**整条** CSP —— 于是 `style-src` 里的 `'unsafe-inline'`
 * 一起被摘掉，内嵌页的实际策略变成 `style-src 'self'`。后果：每次打开任何一种
 * 文档的在线编辑，浏览器控制台固定刷 8~16 条
 * 「Applying inline style violates ... 'style-src ''self''」，编辑器里由内联样式
 * 决定的位置与尺寸拿不到样式。
 *
 * 为什么当初没被任何门禁抓到：那条改动的**本意**是收紧脚本，而四个渲染器发出来的
 * `script-src` 本来就只有 `'self'`（slides/pdf 另带 `'wasm-unsafe-eval'`，那是
 * WASM 需要的、也不该动）—— 也就是说这句全局 replace **对脚本一条都没收紧**，
 * 全部副作用都落在了样式上。安全的改动没有产生任何安全收益，只产生了故障。
 *
 * 保留的只有 `script-src` 内的处理，且 `'wasm-unsafe-eval'` 是另一个 token，
 * 不会被 `'unsafe-eval'` 的匹配吃掉。
 */
export function hardenRendererCsp(content: string): string {
  return content
    .split(';')
    .map((directive) => {
      if (!/^\s*script-src\s/i.test(directive)) return directive
      return directive
        .replace(/\s*'unsafe-inline'/g, '')
        .replace(/\s*'unsafe-eval'/g, '')
    })
    .join(';')
}

/** Editor chrome the skeleton sketches: title bar, ribbon row, page with placeholder text lines. */
const EMBED_SKELETON_HTML = `<div class="go-skel" aria-hidden="true"><div class="go-skel-titlebar"><span class="go-skel-dot"></span><span class="go-skel-dot"></span><span class="go-skel-dot"></span></div><div class="go-skel-ribbon"><span class="go-skel-chip"></span><span class="go-skel-chip"></span><span class="go-skel-chip"></span><span class="go-skel-chip"></span><span class="go-skel-chip"></span></div><div class="go-skel-canvas"><div class="go-skel-page"><div class="go-skel-line" style="width:52%"></div><div class="go-skel-line"></div><div class="go-skel-line"></div><div class="go-skel-line" style="width:88%"></div><div class="go-skel-line"></div><div class="go-skel-line" style="width:64%"></div><div class="go-skel-line"></div><div class="go-skel-line" style="width:78%"></div><div class="go-skel-line"></div><div class="go-skel-line" style="width:36%"></div></div></div></div>`

// Inline style so the skeleton paints before any stylesheet fetch completes;
// colors reference the app's semantic tokens (resolved by the bundled CSS,
// which loads without JS). No raw chrome colors here per the theming rules.
const EMBED_SKELETON_CSS = `
.go-skel{position:fixed;inset:0;display:flex;flex-direction:column;background:var(--chrome-bg);overflow:hidden}
.go-skel-titlebar{height:36px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;background:var(--surface);border-bottom:1px solid var(--border);box-sizing:border-box}
.go-skel-dot{width:10px;height:10px;border-radius:50%;background:var(--border-strong)}
.go-skel-ribbon{height:68px;flex:none;display:flex;align-items:center;gap:10px;padding:0 18px;background:var(--surface);border-bottom:1px solid var(--border);box-sizing:border-box}
.go-skel-chip{height:28px;width:64px;border-radius:6px;background:var(--hover)}
.go-skel-canvas{flex:1;display:flex;justify-content:center;padding:24px 16px;background:var(--canvas)}
.go-skel-page{width:min(720px,100%);height:100%;max-height:960px;background:var(--surface);border:1px solid var(--border);border-radius:2px;padding:64px 56px;box-sizing:border-box}
.go-skel-line{height:12px;border-radius:6px;background:var(--hover);margin-bottom:14px}
@media (prefers-reduced-motion: no-preference){.go-skel-line{animation:go-skel-pulse 1.6s ease-in-out infinite}@keyframes go-skel-pulse{0%,100%{opacity:1}50%{opacity:.45}}}
`

/**
 * Build the embed HTML by reading the editor app's `index.html` and injecting
 * the bridge script + token meta tag right before `</head>`. We avoid
 * rewriting the body so the editor's existing bundle hashes don't drift.
 */
export function buildEmbedHtml(appIndexPath: string, q: EmbedQuery, docId: string): string {
  let html = readFileSync(appIndexPath, 'utf-8')
  // The bridge is now an external `<script src>` — no `'unsafe-inline'`
  // required. Two renderer-side quirks still need rewriting:
  //   1. The renderer's CSP meta tag is re-scoped by `hardenRendererCsp()`
  //      below. It tightens **only** `script-src` — see that function for
  //      why touching `style-src` is not a hardening move but a bug.
  //   2. The renderer's bundle paths are relative (`./assets/index-XYZ.js`).
  //      They must resolve inside the embed directory, not at the origin
  //      root — see the `<base href="./">` note below, which also explains
  //      why the path prefix a reverse proxy mounts us under cannot be
  //      recovered here and must not be assumed to be `/`.
  if (html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
      (m) => m.replace(/content="([^"]*)"/i, (_all, content) => `content="${hardenRendererCsp(content)}"`),
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
  // Editor-outline skeleton: static HTML + inline CSS that paints before the
  // renderer bundle executes and keeps rendering with JavaScript disabled.
  // Colors come from the app stylesheet's semantic tokens (plain CSS — loads
  // without JS), so the skeleton follows light/dark like any other chrome.
  // The markup lives inside <div id="root">, which React clears on first
  // mount — no cleanup code. Guarded replace: a renderer index.html without
  // the exact empty root marker simply ships without a skeleton.
  html = html.replace('<div id="root"></div>', `<div id="root">${EMBED_SKELETON_HTML}</div>`)
  // A dark embed request paints dark from the very first frame; the app's
  // applyTheme() rewrites or removes the attribute after boot.
  if (q.theme === 'dark' && !/<html[^>]*\sdata-theme=/i.test(html)) {
    html = html.replace(/<html(?=[\s>])/i, '<html data-theme="dark"')
  }
  const skeletonTag = `\n<style>${EMBED_SKELETON_CSS}</style>`
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
    aiPanel: q.aiPanel ?? null,
  }
  const configTag = `\n<meta name="genoffice-embed-config" content="${escapeAttr(JSON.stringify(embedConfig))}">`
  const sessionTag = `\n<meta name="genoffice-session" content="${sessionId}">`
  // Bridge is loaded from a same-origin file — no inline `<script>`, no
  // `'unsafe-inline'` requirement in the CSP. Referenced relative to the embed
  // directory (see `EMBED_BRIDGE_SCRIPT_REF`) so it survives a path-prefixed
  // mount; a root-relative `/embed/static/bridge.js` would ask the *host* for
  // that path, which the host does not forward.
  const bridgeTag = `\n<script src="${EMBED_BRIDGE_SCRIPT_REF}"></script>`
  const injection = skeletonTag + tokenTag + nonceTag + configTag + sessionTag + bridgeTag
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
  // Which credential, if any, may ride back to the iframe as `auth_token`?
  // Only one the caller just proved it holds:
  //
  //   - a token that passed JWT verification above → that scoped guest JWT;
  //   - the legacy case, where the caller supplied the operator WEB_TOKEN as
  //     `?token=` and so demonstrated knowledge of it → the operator token,
  //     unchanged from the historical behaviour;
  //   - anything else (an opaque string the caller invented) → nothing.
  //
  // The third branch closes a real disclosure: this endpoint used to stamp
  // the operator WEB_TOKEN on *every* wrapper response, so
  // `/embed/<id>?token=garbage` handed an operator credential to a caller who
  // had presented nothing. It is the iframe's own /api/ipc/* credential in
  // WEB_TOKEN mode, but the bridge cannot stamp headers on EventSource, so
  // the cookie is how it learns the token at all. HttpOnly + SameSite=Strict
  // keep iframe XSS from reading it back; neither addressed giving it out.
  const operatorToken = process.env.WEB_TOKEN
  let credential: string | null = null
  if (tokenCheck.verified) {
    credential = parsed.token
  } else if (operatorToken && parsed.token === operatorToken) {
    credential = operatorToken
  }
  const cookie = credential ? authCookieHeader(credential) : null
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
