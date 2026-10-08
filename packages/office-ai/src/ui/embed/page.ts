/**
 * Embed wrapper page — a port of `apps/web-server/src/embed/index.ts`'s HTML
 * construction. Reads an app renderer's `index.html` and injects the bridge
 * script, the handshake/config meta tags and a pre-boot skeleton, leaving the
 * body otherwise untouched so the renderer's content-hashed asset URLs do not
 * drift.
 *
 * Two behaviours deliberately differ from the web-server original:
 *
 *   - **`?token=` is not mandatory.** web-server has a JWT/shared-secret gate
 *     and needs a token to identify the caller. office-ai's loopback host is
 *     isolated by binding alone and only carries a token when the embedder
 *     asked for one, so an embed URL is `host/embed/<docId>` with no query.
 *   - **App assets resolve through the workspace's `AssetsResolver`**, not a
 *     `WEB_STATIC_ROOT` walk, so the same page works from an explicit
 *     `assetsDir`, the published `@genoffice/office-ai-ui-assets` package, or
 *     the monorepo's `apps/<app>/out/renderer`.
 */
import { readFileSync } from 'node:fs'
import { EMBED_BRIDGE_RELATIVE_PATH } from './bridge'

/** Apps the embed endpoint will serve. Mirrors `ctx.apps` at the call site. */
export type EmbedApp = 'docs' | 'sheets' | 'slides' | 'pdf'

export interface EmbedQuery {
  app: EmbedApp
  mode: string | null
  theme: string | null
  lang: string | null
  toolbar: string | null
  title: string | null
  nonce: string | null
}

export type EmbedQueryResult =
  | { ok: true; docId: string; query: EmbedQuery }
  | { ok: false; status: number; code: string; message: string }

const VALID_APPS: readonly EmbedApp[] = ['docs', 'sheets', 'slides', 'pdf']

/**
 * Pull `:docId` and the presentation query params out of an `/embed/...` URL.
 *
 * Malformed percent-encoding (`/embed/%XY`, a bare `%`) makes
 * `decodeURIComponent` throw `URIError`. Left uncaught it bubbles to the
 * request handler as an unhandled rejection and the response is never sent,
 * so the client hangs to socket timeout — hence the try/catch and the
 * structured 400.
 */
export function parseEmbedQuery(url: URL, available: readonly EmbedApp[]): EmbedQueryResult {
  const docIdRaw = url.pathname.replace(/^\/embed\//, '').split('/')[0] ?? ''
  let docId: string
  try {
    docId = decodeURIComponent(docIdRaw).trim()
  } catch {
    return { ok: false, status: 400, code: 'INVALID_ARGUMENT', message: 'invalid percent-encoding in :docId' }
  }
  if (!docId) {
    return { ok: false, status: 400, code: 'INVALID_ARGUMENT', message: 'missing :docId in path' }
  }
  const requestedApp = (url.searchParams.get('app') ?? 'docs').toLowerCase()
  // An app the embedder has not enabled falls back to the first one that is,
  // rather than 400: a host that only shipped sheets should get sheets when it
  // asks for the default `docs`.
  const app = (VALID_APPS.includes(requestedApp as EmbedApp) &&
  available.includes(requestedApp as EmbedApp)
    ? requestedApp
    : available[0]) as EmbedApp
  return {
    ok: true,
    docId,
    query: {
      app,
      mode: url.searchParams.get('mode'),
      theme: url.searchParams.get('theme'),
      lang: url.searchParams.get('lang'),
      toolbar: url.searchParams.get('toolbar'),
      title: url.searchParams.get('title'),
      nonce: url.searchParams.get('nonce'),
    },
  }
}

/** Editor chrome the skeleton sketches: title bar, ribbon row, page with text lines. */
const SKELETON_HTML =
  `<div class="go-skel" aria-hidden="true"><div class="go-skel-titlebar">` +
  `<span class="go-skel-dot"></span><span class="go-skel-dot"></span><span class="go-skel-dot"></span></div>` +
  `<div class="go-skel-ribbon"><span class="go-skel-chip"></span><span class="go-skel-chip"></span>` +
  `<span class="go-skel-chip"></span><span class="go-skel-chip"></span><span class="go-skel-chip"></span></div>` +
  `<div class="go-skel-canvas"><div class="go-skel-page">` +
  `<div class="go-skel-line" style="width:52%"></div><div class="go-skel-line"></div>` +
  `<div class="go-skel-line"></div><div class="go-skel-line" style="width:88%"></div>` +
  `<div class="go-skel-line"></div><div class="go-skel-line" style="width:64%"></div>` +
  `<div class="go-skel-line"></div><div class="go-skel-line" style="width:78%"></div>` +
  `<div class="go-skel-line"></div><div class="go-skel-line" style="width:36%"></div>` +
  `</div></div></div></div>`

// Inline so the skeleton paints before any stylesheet fetch completes. Every
// colour is a semantic token from the app's own stylesheet (plain CSS, loads
// without JS), so it follows light/dark like any other chrome — no raw hex, per
// the repo theming rules.
const SKELETON_CSS = `
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
 * Re-scope a renderer-shipped CSP `content` value, touching **only** `script-src`
 * so the renderer's own meta CSP cannot quietly degrade into "anything goes".
 *
 * Touching `style-src` here is not hardening, it is a bug that already shipped
 * once: an unscoped `.replace(/\s*'unsafe-inline'/g, '')` stripped
 * `'unsafe-inline'` out of the renderers' `style-src 'self' 'unsafe-inline'`,
 * producing a steady stream of "Applying inline style violates … 'style-src
 * ''self''" and leaving inline-styled editor geometry unstyled. Because the
 * shipped `script-src` values were already just `'self'` (plus
 * `'wasm-unsafe-eval'`, a distinct token the `'unsafe-eval'` pattern cannot
 * match), the change tightened no script at all — every effect landed on
 * styles. `'wasm-unsafe-eval'` must survive.
 */
export function hardenRendererCsp(content: string): string {
  return content
    .split(';')
    .map((directive) => {
      if (!/^\s*script-src\s/i.test(directive)) return directive
      return directive.replace(/\s*'unsafe-inline'/g, '').replace(/\s*'unsafe-eval'/g, '')
    })
    .join(';')
}

export interface BuildEmbedHtmlOptions {
  /** Absolute path to the chosen app's `index.html`. */
  appIndexPath: string
  docId: string
  query: EmbedQuery
  /** Per-request session id; also the SSE channel the bridge subscribes to. */
  sessionId: string
  /** Only present when the host was started with a token. */
  token: string | null
}

export function buildEmbedHtml(options: BuildEmbedHtmlOptions): string {
  const { appIndexPath, docId, query, sessionId, token } = options
  let html = readFileSync(appIndexPath, 'utf-8')

  if (html.includes('http-equiv="Content-Security-Policy"')) {
    html = html.replace(
      /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
      (m) => m.replace(/content="([^"]*)"/i, (_all, content) => `content="${hardenRendererCsp(content)}"`),
    )
  } else {
    html = html.replace(
      /<\/head>/i,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*">\n</head>`,
    )
  }

  // `<base href="./">` — the embed page's own directory, NOT the origin root.
  // The renderer references its bundle relatively (`./assets/index-*.js`), which
  // resolves against the origin root only when this host is mounted at `/`.
  // Behind a path prefix the browser would ask the *host* for `/assets/…`, a
  // path the host does not forward, and the iframe renders blank. Directory-
  // relative is correct under both mountings because it inherits whatever
  // prefix the iframe URL already carries — and a reverse proxy strips the
  // prefix upstream, so no server-side state can recover it.
  html = html.replace(/<head>/i, (_m) => `<head>\n<base href="./">`)

  // Inside <div id="root">, which React clears on first mount — no cleanup
  // needed. Guarded: a renderer without the exact marker simply has no skeleton.
  html = html.replace('<div id="root"></div>', `<div id="root">${SKELETON_HTML}</div>`)

  if (query.theme === 'dark' && !/<html[^>]*\sdata-theme=/i.test(html)) {
    html = html.replace(/<html(?=[\s>])/i, '<html data-theme="dark"')
  }

  const embedConfig = {
    docId,
    app: query.app,
    mode: query.mode ?? 'edit',
    theme: query.theme ?? 'auto',
    lang: query.lang ?? 'en-US',
    toolbar: query.toolbar ?? 'full',
    title: query.title ?? null,
    sessionId,
  }

  const injection =
    `\n<style>${SKELETON_CSS}</style>` +
    (token ? `\n<meta name="genoffice-token" content="${escapeAttr(token)}">` : '') +
    (query.nonce ? `\n<meta name="genoffice-nonce" content="${escapeAttr(query.nonce)}">` : '') +
    `\n<meta name="genoffice-embed-config" content="${escapeAttr(JSON.stringify(embedConfig))}">` +
    `\n<meta name="genoffice-session" content="${escapeAttr(sessionId)}">` +
    // Relative to the embed directory, so it survives a path-prefixed mount.
    `\n<script src="${EMBED_BRIDGE_RELATIVE_PATH}"></script>`

  // Case-insensitive against `</head>` so a minified `<HEAD>` still gets the
  // bridge injected instead of producing a blank page.
  return html.replace(/<\/head>/i, (_match) => `${injection}</head>`)
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/** Per-request session id for the iframe's SSE push channel. */
export function mintEmbedSessionId(): string {
  return `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
