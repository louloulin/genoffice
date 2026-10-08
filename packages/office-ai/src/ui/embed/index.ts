/**
 * `/embed/**` routes — the iframe wrapper a host SDK frames.
 *
 * `GET /embed/<docId>` serves the chosen app's renderer with the bridge script,
 * handshake meta and a pre-boot skeleton injected. The other two routes exist
 * only to make that page work:
 *
 *   - `/embed/static/bridge.js` — the bridge itself.
 *   - `/embed/assets/**` — the renderer's own bundle. It lands here because the
 *     wrapper sets `<base href="./">` (the only `<base>` form correct under a
 *     path-prefixed reverse-proxy mount), which makes `./assets/index-*.js`
 *     resolve under `/embed/`. Serving it from here rather than letting it fall
 *     through to the app-page route is what keeps the iframe from rendering
 *     blank: the app-page parser would read `assets` as the app name and answer
 *     a structured 400, which the browser reports as a MIME failure.
 *
 * `:docId` identifies the document for SDK commands (comments, versions) but
 * **never resolves document bytes** — the renderer opens its own file through
 * `?open=<workspace path>`, exactly as in the web-server original. The two are
 * independent: `/embed/report.docx?open=/tmp/…/report.docx` is a valid URL.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'

import type { UiHostContext } from '../host'
import { MIME_TYPES } from '../mime'
import { serveStaticFile } from '../static-serve'
import { isAuthorizedRequest } from '../token-check'
import { EMBED_BRIDGE_SOURCE } from './bridge'
import { buildEmbedHtml, mintEmbedSessionId, parseEmbedQuery } from './page'

export { EMBED_BRIDGE_SOURCE, EMBED_BRIDGE_SCRIPT_PATH, EMBED_BRIDGE_VERSION } from './bridge'
export { buildEmbedHtml, hardenRendererCsp, parseEmbedQuery, escapeAttr } from './page'
export type { EmbedQuery } from './page'
export { createEmbedState, registerSdkCommandHandlers, supportedSdkCommands } from './sdk-commands'
export type { EmbedState } from './sdk-commands'

/**
 * Handle an `/embed/**` request. Returns false when the path is not ours so the
 * caller can fall through to its own routing.
 */
export function handleEmbed(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  url: URL,
): boolean {
  if (!url.pathname.startsWith('/embed/')) return false

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'GET required',
        channel: url.pathname,
        allow: 'GET',
      },
    })
    return true
  }

  if (url.pathname === '/embed/static/bridge.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    })
    response.end(EMBED_BRIDGE_SOURCE)
    return true
  }

  if (url.pathname.startsWith('/embed/assets/')) {
    return serveEmbedAsset(request, response, ctx, url)
  }

  return serveEmbedPage(request, response, ctx, url)
}

// ----- routes ----------------------------------------------------------------

function serveEmbedPage(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  url: URL,
): boolean {
  const parsed = parseEmbedQuery(url, ctx.apps)
  if (!parsed.ok) {
    sendJson(response, parsed.status, { error: { code: parsed.code, message: parsed.message } })
    return true
  }
  // The wrapper carries the live credential, so it must never be cached — a
  // token rotation has to propagate to the next iframe load.
  if (ctx.token && !isAuthorizedRequest(url, request.headers, ctx.token)) {
    sendJson(response, 401, { error: { code: 'UNAUTHENTICATED', message: 'missing or invalid token' } })
    return true
  }

  const appDir = ctx.assets.resolveAppDir(parsed.query.app)
  if (!appDir) {
    sendJson(response, 503, {
      error: {
        code: 'EMBED_APP_NOT_BUILT',
        message: `editor app "${parsed.query.app}" is not built — pass assetsDir or install @genoffice/office-ai-ui-assets`,
      },
    })
    return true
  }
  const indexPath = resolve(appDir, 'index.html')
  if (!existsSync(indexPath)) {
    sendJson(response, 503, {
      error: {
        code: 'EMBED_APP_NOT_BUILT',
        message: `editor app "${parsed.query.app}" is missing index.html under its assets directory`,
      },
    })
    return true
  }

  const html = buildEmbedHtml({
    appIndexPath: indexPath,
    docId: parsed.docId,
    query: parsed.query,
    sessionId: mintEmbedSessionId(),
    token: ctx.token,
  })
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `frame-ancestors ${ctx.frameAncestors}`,
  })
  response.end(request.method === 'HEAD' ? undefined : html)
  return true
}

function serveEmbedAsset(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  url: URL,
): boolean {
  const relative = url.pathname.slice('/embed/assets/'.length).replace(/^\/+/, '')
  if (!relative) {
    sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'missing asset path' } })
    return true
  }
  // The asset URL carries no `?app=` (relative resolution drops the query), so
  // the owning app is unknown. Content-hashed bundle names make "first app
  // that has this file" the right answer, which is the same fallback the
  // top-level static route uses.
  for (const app of ctx.apps) {
    const appDir = ctx.assets.resolveAppDir(app)
    if (!appDir) continue
    // A renderer may reference its bundle as `assets/x.js` or `./assets/x.js`
    // from the page root; both land here stripped of nothing, so try the app
    // dir and its `assets/` subdir.
    for (const candidateRelative of unique([relative, `assets/${relative}`])) {
      const candidate = resolve(appDir, candidateRelative)
      if (candidate !== appDir && !candidate.startsWith(appDir + sep)) continue
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        serveStaticFile({
          request,
          response,
          filePath: candidate,
          contentType: MIME_TYPES[extnameOf(candidate)] ?? 'application/octet-stream',
        })
        return true
      }
    }
  }
  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: `no such asset: ${url.pathname}` } })
  return true
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

// ----- helpers ---------------------------------------------------------------

/**
 * `frame-ancestors` for the wrapper. Fail-closed: a token the caller cannot
 * parse collapses the whole list to `'self'` rather than shipping a policy that
 * permits more than intended. `*` and `'none'` are honoured only as the entire
 * value — both contradict a longer list (`*` subsumes it, and CSP ignores
 * `'none'` when other sources are present).
 *
 * `raw` comes from the host's `frameAncestors` option, falling back to
 * `EMBED_FRAME_ANCESTORS` for deployments that configure by environment.
 */
export function resolveFrameAncestors(raw?: string): string {
  const fallback = "'self'"
  const value = raw ?? process.env.EMBED_FRAME_ANCESTORS
  if (!value) return fallback
  const tokens = value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return fallback
  if (tokens.length === 1 && (tokens[0] === '*' || tokens[0] === "'none'")) return tokens[0]
  if (!tokens.every((token) => /^(?:'self'|https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?)$/.test(token))) return fallback
  return tokens.join(' ')
}

function extnameOf(filePath: string): string {
  const index = filePath.lastIndexOf('.')
  return index === -1 ? '' : filePath.slice(index)
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}
