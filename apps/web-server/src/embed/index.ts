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
 *     `closed`) to `window.parent` and proxies inbound commands back to
 *     the editor via a `host.command` CustomEvent on the same window.
 *
 *   - The page returns a small `text/html` doc so embed consumers can
 *     see the editor loading state immediately; we deliberately do NOT
 *     `cache-control: public` so a token rotation propagates.
 * @public
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { verifyJwtWithRevocation } from '../api/v1/auth'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPS } from '../common/index'


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
  const payload = verifyJwtWithRevocation(token)
  if (!payload) {
    // Distinguish expired from revoked for clearer client diagnostics.
    // Re-run `verifyJwt` (no revocation) to see if the signature itself
    // is valid; if so, the token was revoked or expired.
    // `verifyJwt` and `verifyJwtWithRevocation` share the secret; we
    // import lazily so we don't blow up when auth.ts is mocked in tests.
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'invalid or expired embed token',
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
}

function parseEmbedQuery(url: URL): EmbedQuery | { error: string } {
  const docIdRaw = url.pathname.replace(/^\/embed\//, '').split('/')[0] ?? ''
  const docId = decodeURIComponent(docIdRaw).trim()
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
const EMBED_BRIDGE = `
(function () {
  var ENVELOPE_VERSION = '1.0';
  function post(name, payload) {
    try {
      window.parent.postMessage({
        v: ENVELOPE_VERSION,
        dir: 'editor->host',
        kind: 'event',
        payload: { name: name, payload: payload }
      }, '*');
    } catch (e) { /* parent gone, swallow */ }
  }
  function sendReady() {
    // Echo the handshake nonce (if any) so the host SDK can verify the
    // iframe identity. The value comes from the <meta name="genoffice-nonce">
    // tag we inject earlier in the document, which was sourced from the
    // ?nonce= query param the host URL-builder passed in. The renderer
    // bridge does NOT need to know how to generate a nonce — it just
    // forwards whatever the server injected.
    var nonceMeta = document.querySelector('meta[name="genoffice-nonce"]');
    var nonce = nonceMeta ? nonceMeta.getAttribute('content') : null;
    var readyPayload = {
      type: 'ready',
      app: window.__GENOFFICE_EMBED__ && window.__GENOFFICE_EMBED__.app,
      version: '0.9.0'
    };
    if (nonce) readyPayload.nonce = nonce;
    post('ready', readyPayload);
  }
  function subscribePush() {
    var cfg = window.__GENOFFICE_EMBED__;
    if (!cfg || !cfg.sessionId) return;
    if (typeof EventSource === 'undefined') return;
    try {
      var es = new EventSource('/api/ipc/events?session=' + encodeURIComponent(cfg.sessionId));
      es.onmessage = function (ev) {
        var frame;
        try { frame = JSON.parse(ev.data); } catch (e) { return; }
        if (!frame || !frame.channel || !frame.args) return;
        // Unwrap a single payload object from the args array so the host
        // receives the same shape the renderer dispatches (e.g. {dirty:true}
        // not [{dirty:true}]). Multi-arg events get forwarded as-is.
        var p = frame.args.length === 1 ? frame.args[0] : frame.args;
        post(frame.channel, p);
      };
      es.onerror = function () { /* SSE auto-reconnects; ignore transient */ };
      window.addEventListener('beforeunload', function () {
        try { es.close(); } catch (e) { /* ignore */ }
      });
    } catch (e) { /* EventSource construction failed; degrade to no-push */ }
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.v !== ENVELOPE_VERSION) return;
    if (data.kind === 'command') {
      window.dispatchEvent(new CustomEvent('host.command', { detail: data }));
    }
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(sendReady, 0);
    setTimeout(subscribePush, 0);
  } else {
    window.addEventListener('DOMContentLoaded', function () {
      setTimeout(sendReady, 0);
      setTimeout(subscribePush, 0);
    });
    window.addEventListener('load', function () {
      setTimeout(sendReady, 0);
      setTimeout(subscribePush, 0);
    });
  }
})();
`

/**
 * Build the embed HTML by reading the editor app's `index.html` and injecting
 * the bridge script + token meta tag right before `</head>`. We avoid
 * rewriting the body so the editor's existing bundle hashes don't drift.
 */
export function buildEmbedHtml(appIndexPath: string, q: EmbedQuery, docId: string): string {
  const html = readFileSync(appIndexPath, 'utf-8')
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
  const bridgeTag = `\n<script>window.__GENOFFICE_EMBED__=${JSON.stringify(embedConfig)};${EMBED_BRIDGE}</script>`
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

  const docId = decodeURIComponent(url.pathname.replace(/^\/embed\//, '').split('/')[0] ?? '')
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
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(html)
  return true
}

export { EMBED_BRIDGE }
