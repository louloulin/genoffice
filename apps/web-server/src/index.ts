/**
 * GenOffice Web Server — standalone HTTP service that mirrors the Electron
 * main-process IPC surface so the same renderer code can run in a browser
 * without launching Electron.
 *
 * The boot path is intentionally thin:
 *
 *   1. Wire every capability module into the shared handler registry.
 *   2. Bring up a single HTTP server that multiplexes:
 *        - GET  /health                 — health probe
 *        - GET  /api/channels           — list registered channels
 *        - GET  /api/collab/sessions    — collab session snapshot
 *        - POST /api/ipc/:channel       — JSON-over-HTTP IPC invoke
 *        - GET  /api/ipc/events         — SSE event stream per session
 *        - POST /api/ai/stream          — Agent-Loop SSE stream
 *        - POST /api/ai/translate       — Synchronous batch translate (JSON)
 *        - POST /api/ai/translate/stream — SSE translate stream (start/unit/quality/complete/error)
 *        - POST /api/ai/translate/stream/cancel — abort an in-flight stream
 *      and falls back to the static docs renderer when no API route hits.
 *
 * The capability code lives in capability-specific sub-directories
 * (`apps/web-server/src/{ai,projects,docs,slides,sheets,pdf,markdown,shell,
 * collab,enterprise,common,anydoc,web}`). See LUM-553 for the refactor plan.
 */
import { createServer, type IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'

import {
  APPS,
  COLLAB_SESSIONS,
  HOST,
  MIME_TYPES,
  PORT,
  STATIC_ROOT,
  WEB_TEMP_ROOT,
  decodeTransportValue,
  initRecentState,
  sweepWebTempRoot,
  encodeTransportValue,
  getHandler,
  getHandlerEntry,
  handlerCount,
  listChannels,
} from './common/index'
import { fileIndexStore } from './common/file-index-store'
import { flushFileManagementState } from './common/document-stores'
import { WEB_SERVER_VERSION } from './common/version'
import { MAX_HTTP_BODY_BYTES, readBodyWithCap } from './common/read-body'
import { registerAiHandlers, AI_STREAM_SESSIONS, runProviderStream } from './ai/index'
import { loadMarketplace } from './common/marketplace-loader'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'
import { getDefaultSkillRegistry } from '@genoffice/agent-skills'
import { classifyWebError, ipcErrorStatus, InvalidArgumentError } from './ai/errors'
import {
  handleTranslateBatchHttp,
  handleTranslateStreamHttp,
  handleTranslateStreamCancelHttp,
} from './ai/translate-http'
import { handleLanguagesHttp } from './ai/languages-http'
import { translationStateSummary } from './ai/chat'
import type { AiSettings, AiStreamChunk } from '@genoffice/ai-provider'
import { registerProjectHandlers } from './projects/index'
import { registerDocsHandlers } from './docs/index'
import { registerSheetsHandlers } from './sheets/index'
import { registerSlidesHandlers } from './slides/index'
import { registerPdfHandlers } from './pdf/index'
import { registerMarkdownHandlers } from './markdown/index'
import { getHtmlPreviewBuffer, registerHtmlHandlers } from './html/index'
import { registerShellHandlers } from './shell/index'
import { registerCollabHandlers } from './collab/index'
import { registerEnterpriseHandlers } from './enterprise/index'
import { registerAnydocHandlers } from './anydoc/index'
import { registerWebHandlers } from './web/index'
import { registerVersionHistoryHandlers } from './common/version-history'
import { startAuditRotateWorker } from './common/audit-log'
import { isAuthorised, isPublicApiPath, writeUnauthorized } from './auth/index'
// sdk1 §11.111: handleApiV1 + findV1Route are imported together so the
// v1 dispatcher catch-all can return 405 METHOD_NOT_ALLOWED with the
// correct Allow list when a pathname matches a known v1 route but the
// requested method isn't supported (RFC 7231). Without the route table
// the catch-all would return 404 NOT_FOUND for paths that exist for
// other methods, which is an RFC 7231 violation.
import { findV1Route, handleApiV1 } from './api/v1/index'
import { requireScopeFromHeaders, verifyJwtWithRevocation } from './api/v1/auth'

/**
 * True when the request carries an `Authorization: Bearer …` header. Used
 * by the IPC dispatcher to decide whether the soft scope gate (§11.78)
 * should fire: callers that present a JWT get the full scope check;
 * callers without a token (legacy web-renderer IPC, WEB_TOKEN-cookie
 * sessions) fall through to the existing trust model.
 */
function hasAuthorizationHeader(headers: unknown): boolean {
  const h = headers as { authorization?: unknown } | null | undefined
  const raw = h?.authorization
  return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('bearer ')
}
import { handleEmbed } from './embed/index'
import { registerSdkCommandHandlers } from './embed/sdk-commands'

function authCookieHeader(): string | null {
  const token = process.env.WEB_TOKEN
  if (!token) return null
  // Token is treated as a cookie value (RFC 6265 §4.1.1): characters
  // outside the allowed set are percent-encoded by encodeURIComponent so
  // the browser parses the Set-Cookie header cleanly. The auth gate
  // reverses the encoding with decodeURIComponent before comparing.
  // Path=/ so every IPC call (mounted under /api/ipc/…) sees the cookie.
  // Max-Age is set to one week so a long-running editor session does not
  // suddenly lose auth; the operator can clear it via DevTools if they
  // need to invalidate. HttpOnly keeps the cookie out of document.cookie
  // so an XSS payload inside the editor cannot exfiltrate the secret.
  return `auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
}

// ----- global error traps (must run before any handler so unexpected
//       failures in the pi session bridge show a stack instead of dying silently)
process.on('uncaughtException', (err) => {
  console.error('[genoffice] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[genoffice] unhandledRejection:', reason)
})

// ----- capability wiring ----------------------------------------------------
// Sweep stale WEB_TEMP_ROOT uploads (older than 24 h) before any handler can
// observe them. Safe to skip on failure — a misbehaving boot path should
// not abort the whole server.
try {
  const gc = sweepWebTempRoot(WEB_TEMP_ROOT)
  if (gc.removed > 0) {
    console.log(`[genoffice] swept ${gc.removed} stale upload directory(ies) from ${WEB_TEMP_ROOT}`)
  }
} catch (error) {
  console.warn('[genoffice] temp-root sweep failed:', error)
}

initRecentState()
/* Audit-log retention worker (sdk1 §A.5 audit-log backlog close).
 * Periodically trims audit-log.jsonl to entries within
 * GENOFFICE_AUDIT_RETENTION_DAYS (default 90). The timer is unref'd
 * inside startAuditRotateWorker() so it never holds shutdown open. */
startAuditRotateWorker()
/* Rehydrate the persisted upload index BEFORE any handler can serve a
 * `files:read({id})`: an id issued in a previous session must resolve from the
 * first request after a restart, not only after the next upload. */
fileIndexStore.fromDiskSync()
registerAiHandlers()
// Third-party provider / skill marketplace: read genoffice.providers.json +
// genoffice.skills.json (from env / DATA_DIR / cwd / repo) and dynamically
// import each module. Failures are logged, not fatal. See
// apps/web-server/src/common/marketplace-loader.ts.
loadMarketplace({
  providersRegistry: getDefaultProviderRegistry(),
  skillRegistry: getDefaultSkillRegistry(),
}).then((result) => {
  if (result.providers.length > 0) {
    console.log(`[marketplace] loaded ${result.providers.length} provider(s): ${result.providers.map((p) => p.plugin.id).join(', ')}`)
  }
  if (result.skills.length > 0) {
    console.log(`[marketplace] loaded ${result.skills.length} skill(s): ${result.skills.map((s) => s.definition.id).join(', ')}`)
  }
  if (result.errors.length > 0) {
    console.warn(`[marketplace] ${result.errors.length} failed to load:`)
    for (const err of result.errors) {
      console.warn(`[marketplace]   - ${err.entry.name}: ${err.error}`)
    }
  }
}).catch((err: Error) => {
  console.warn('[marketplace] loader crashed:', err.message)
})
registerProjectHandlers()
registerDocsHandlers()
registerSheetsHandlers()
registerSlidesHandlers()
registerPdfHandlers()
registerMarkdownHandlers()
registerHtmlHandlers()
registerShellHandlers()
registerCollabHandlers()
registerEnterpriseHandlers()
registerAnydocHandlers()
registerWebHandlers()
registerVersionHistoryHandlers()
registerSdkCommandHandlers()

// ----- HTTP helpers --------------------------------------------------------
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  try {
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(payload))
  } catch {
    // Socket already torn down (peer reset, payload-too-large abort).
    // Nothing useful we can do; the caller has already logged the cause.
  }
}

function sendSseError(
  response: ServerResponse,
  error: unknown,
  requestId: string | undefined,
): void {
  // `writeSseEvent` is defined in `translate-http.ts`; for the chat stream we
  // inline the two-line shape so this module does not gain a new dependency.
  // Callers that have already sent the 200 SSE header cannot recover with a
  // new status code — the only correct way out is a final `error` event and
  // an end of the chunked stream.
  const errObj: { message: string; code?: string; channel?: string; reason?: string } = {
    message: error instanceof Error ? error.message : String(error),
  }
  const anyErr = error as { code?: unknown; channel?: unknown; reason?: string }
  if (typeof anyErr?.code === 'string') errObj.code = anyErr.code
  if (typeof anyErr?.channel === 'string') errObj.channel = anyErr.channel
  if (typeof anyErr?.reason === 'string') errObj.reason = anyErr.reason
  const payload = JSON.stringify({
    type: 'error',
    error: errObj.message,
    ...(errObj.code ? { code: errObj.code } : {}),
    ...(requestId ? { requestId } : {}),
  })
  try {
    response.write(`data: ${payload}\n\n`)
  } catch {
    // socket already gone — finally block will close it
  }
}

function sendIpcError(
  response: ServerResponse,
  error: unknown,
  structuredAware: boolean = true,
  channel?: string,
): void {
  // Normalise first: a handler that destructured a missing `args` throws a
  // bare TypeError, which reads as a server fault unless it is classified as
  // the malformed request it actually is.
  const classified = channel ? classifyWebError(error, channel) : error
  const errObj: { message: string; code?: string; channel?: string; reason?: string } = {
    message: (classified as Error)?.message
      ? String((classified as Error).message)
      : String(classified),
  }
  if (structuredAware) {
    const anyErr = classified as { code?: unknown; channel?: unknown; reason?: unknown }
    if (typeof anyErr?.code === 'string') errObj.code = anyErr.code
    if (typeof anyErr?.channel === 'string') errObj.channel = anyErr.channel
    if (typeof anyErr?.reason === 'string') errObj.reason = anyErr.reason
  }
  sendJson(response, ipcErrorStatus(errObj.code), { error: errObj })
}

/** Read the request body as a UTF-8 string, enforcing MAX_HTTP_BODY_BYTES.
 *  See ./common/read-body for the full rationale. */
const readBody = (request: IncomingMessage): Promise<string> =>
  readBodyWithCap(request, MAX_HTTP_BODY_BYTES)

// SSE plumbing — mirrors the legacy single-file implementation. Each
// session keeps its own Set<ServerResponse> so renderer tabs share one
// push channel.
const sessionConnections = new Map<string, Set<ServerResponse>>()
const PENDING_FRAMES = new Map<string, string[]>()
const SSE_HEARTBEAT_MS = 25000

function pushSseEvent(session: string, channel: string, args: unknown[]): void {
  const encodedArgs = args.map((arg) => encodeTransportValue(arg))
  const frame = `data: ${JSON.stringify({ channel, args: encodedArgs })}\n\n`
  const connections = sessionConnections.get(session)
  if (connections) {
    // A write failure means the client socket is gone; drop the dead
    // connection instead of retrying every subsequent event against it.
    for (const response of connections) {
      try {
        response.write(frame)
      } catch (error) {
        connections.delete(response)
        // The listener that populated this set removes itself on 'close',
        // but a write can fail before 'close' fires (half-open sockets).
      }
    }
  } else {
    const pending = PENDING_FRAMES.get(session) || []
    pending.push(frame)
    if (pending.length > 100) pending.shift()
    PENDING_FRAMES.set(session, pending)
  }
}

/**
 * Resolve a renderer file inside `<app>/out/renderer`, refusing anything that
 * escapes that root.
 *
 * `relativePath` is attacker-controlled request data. `path.resolve` throws
 * away everything to the left of an absolute segment, so `GET /docs//etc/passwd`
 * (the route regex captures `/etc/passwd`) used to hand `createReadStream` a
 * path outside STATIC_ROOT and serve any readable file on the host. Callers
 * pass a path with its leading slashes already stripped, and this containment
 * check is the second line of defence for `..` segments.
 *
 * Returns null when the candidate escapes, so callers can distinguish
 * "outside the root" from "inside the root but missing".
 */
function resolveRendererFile(appName: string, relativePath: string): string | null {
  const root = resolve(STATIC_ROOT, appName, 'out', 'renderer')
  const candidate = resolve(root, relativePath.replace(/^[/\\]+/, ''))
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  return candidate
}

/**
 * Resolve the value for the `Access-Control-Allow-Origin` response header.
 *
 * Priority:
 *   1. `WEB_CORS_ORIGINS` (comma-separated allowlist) — match against the
 *      request's Origin; return it on hit, omit the header on miss.
 *   2. `WEB_CORS_ORIGIN="*"` — explicit opt-in to the old open behaviour
 *      for trusted deployments (e.g. behind a same-origin reverse proxy).
 *   3. Default: echo the request's Origin so credentials work in dev
 *      (localhost:18081, localhost:5173, LAN hosts). A missing Origin
 *      means a same-origin request — no header needed.
 */
const CORS_ALLOWLIST = (process.env.WEB_CORS_ORIGINS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)
const CORS_EXPLICIT = process.env.WEB_CORS_ORIGIN
function resolveCorsOrigin(requestOrigin: string | string[] | undefined): string | null {
  const origin = Array.isArray(requestOrigin) ? requestOrigin[0] : requestOrigin
  if (CORS_EXPLICIT === '*') return '*'
  if (!origin) return null
  if (CORS_ALLOWLIST.length > 0) {
    return CORS_ALLOWLIST.includes(origin) ? origin : null
  }
  return origin
}

// ----- request handling ----------------------------------------------------
const server = createServer(async (request, response) => {
  // sdk1 §11.121: outermost defensive wrapper. ANY unhandled exception
  // thrown from a downstream handler must not become an unhandled rejection
  // — that path leaves the HTTP socket open with no response, so the
  // client hangs until the OS timeout (curl --max-time 5 fails with status
  // 000). This outer try/catch answers a structured 500 envelope before
  // the socket can be reaped, and logs the error for the operator.
  // Specific bugs (e.g. the §11.121 `decodeURIComponent` throw in
  // `parseEmbedQuery`) are handled closer to the source with structured
  // 400s; this is the last-resort safety net for any future regression.
  try {
  // A malformed request target (`GET /api/html/preview/%`, bad percent-encoding)
  // or a missing/HTTP-1.0 Host header makes the URL constructor throw. A throw
  // that escapes the request listener is fatal: the global trap only logs it and
  // the event loop then dies, so one request could take the whole server down.
  // Answer 400 instead.
  let url: URL
  try {
    url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  } catch {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ error: { message: 'Malformed request URL', code: 'INVALID_ARGUMENT' } }),
    )
    return
  }
  const pathPrefix = (process.env.WEB_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '')
  const prefix = pathPrefix ? `/${pathPrefix}` : ''
  const requestPath =
    prefix && url.pathname.startsWith(`${prefix}/`)
      ? url.pathname.slice(prefix.length) || '/'
      : url.pathname
  url.pathname = requestPath

  // CORS: by default, echo the request's Origin so credentials work in dev.
  // Override with WEB_CORS_ORIGINS (comma-separated allowlist) or WEB_CORS_ORIGIN="*"
  // to restore the previous open behaviour for a trusted deployment.
  const corsOrigin = resolveCorsOrigin(request.headers.origin)
  if (corsOrigin) {
    response.setHeader('Access-Control-Allow-Origin', corsOrigin)
    response.setHeader('Vary', 'Origin')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-IPC-Session')
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  // Phase 1 auth gate. Every `/api/*` request must carry a token when
  // `WEB_TOKEN` is set; the small public allowlist (`/health`,
  // `/api/channels`, `/api/html/preview/*`) stays open so health
  // probes, channel discovery, and anonymous previews keep working.
  // Without `WEB_TOKEN`, the gate is a no-op — dev / e2e / desktop
  // preload builds all rely on that open posture.
  if (
    url.pathname.startsWith('/api/') &&
    !isPublicApiPath(url.pathname) &&
    // Pass url so the auth gate can read `?token=` (the only token transport
    // EventSource supports). Same-origin browser traffic that loaded the
    // page from us ships the token this way; external API consumers still
    // need to put it in the Authorization header. Pass `headers` explicitly
    // because spreading IncomingMessage through {...request, …} loses
    // properties the parser stores as non-enumerable getters, which the
    // auth gate then sees as `undefined`.
    !isAuthorised({ headers: request.headers, url })
  ) {
    writeUnauthorized(response, `Missing or invalid token for ${url.pathname}`)
    return
  }

  // sdk1 §11.110: wrong-method requests return 405 instead of SPA HTML.
  if (url.pathname === '/health') {
    if (request.method !== 'GET') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'GET required',
          channel: url.pathname,
          allow: 'GET',
        },
      })
      return
    }
    const translation = translationStateSummary()
    sendJson(response, 200, {
      status: 'ok',
      version: WEB_SERVER_VERSION,
      mode: 'web-server',
      implementedChannels: handlerCount(),
      features: ['ai', 'collab', 'files', 'projects'],
      translation: {
        kbLoaded: translation.kbLoaded,
        kbTerms: translation.kbTerms,
        tmLoaded: translation.tmLoaded,
        tmPairs: translation.tmPairs,
        defaultProvider: translation.defaultProvider,
      },
      auth: process.env.WEB_TOKEN ? 'required' : 'open',
    })
    return
  }

  /**
   * `GET /api/channels`
   *
   * Discovery endpoint — returns the list of IPC channels the server
   * currently registers (`{ protocolVersion, minClientVersion, channels }`).
   * Renderers call this on boot to negotiate protocol version and pick the
   * right transport. Public and unauthenticated; no JWT or scope required.
   * @public
   */
  // sdk1 §11.107: wrong-method requests must return 405 with a
  // structured envelope instead of falling through to the SPA
  // static fallback (which would serve the index.html and confuse
  // API clients with a 200 + HTML body — same shape inconsistency
  // observed for /api/ai/pi-prompt and /api/ai/languages).
  if (url.pathname === '/api/channels') {
    if (request.method !== 'GET') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'GET required',
          channel: url.pathname,
          allow: 'GET',
        },
      })
      return
    }
    sendJson(response, 200, {
      protocolVersion: 1,
      minClientVersion: 1,
      channels: listChannels(),
    })
    return
  }

  // ----- REST API v1 (stable, public-documented surface) -----
  if (url.pathname.startsWith("/api/v1/")) {
    try {
      const handled = await handleApiV1({ request, response, pathname: url.pathname, method: request.method || "GET" })
      if (handled) return
      // No handler matched. sdk1 §11.111: if the pathname matches a
      // known v1 route but the wrong HTTP method was used, return 405
      // with an Allow list per RFC 7231 instead of falling through to
      // 404 NOT_FOUND. 404 is reserved for paths that don't exist at
      // any method; "path exists, method wrong" must be 405.
      const requestedMethod = (request.method || 'GET').toUpperCase()
      const route = findV1Route(url.pathname)
      if (route && !route.methods.includes(requestedMethod)) {
        const allow = route.methods.join(', ')
        sendJson(response, 405, {
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: `Method ${requestedMethod} not allowed for ${url.pathname}; use ${allow}`,
            channel: url.pathname,
            allow,
          },
        })
        return
      }
      // No handler matched AND no route matches — path is unknown.
      // Return 404 with a structured envelope instead of falling through
      // to the SPA static fallback (which would serve HTML and confuse
      // API clients with a 200 + index.html).
      sendJson(response, 404, {
        error: {
          code: 'NOT_FOUND',
          message: `No handler for ${request.method || 'GET'} ${url.pathname}`,
          channel: url.pathname,
        },
      })
      return
    } catch (err) {
      sendIpcError(response, err, true, url.pathname)
      return
    }
  }

  // sdk1 §11.108: wrong-method requests must return 405 instead of
  // falling through to the SPA fallback (same pattern as §11.107 for
  // /api/channels + /api/ai/pi-prompt). Only GET is documented; POST /
  // PUT / DELETE are rejected with the structured envelope.
  if (url.pathname === '/api/collab/sessions') {
    if (request.method !== 'GET') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'GET required',
          channel: url.pathname,
          allow: 'GET',
        },
      })
      return
    }
    const sessions = [...COLLAB_SESSIONS.entries()].map(([docId, session]) => ({
      docId,
      users: [...session.users],
      lastActivity: session.lastActivity,
    }))
    sendJson(response, 200, { sessions })
    return
  }

  // sdk1 §11.111 (continuation): /api/html/preview/<id> is GET-only and
  // the previous caller-side `&& request.method === 'GET'` gate meant
  // POST / PUT / DELETE silently fell through to the SPA static fallback
  // (200 + <!doctype html>). Same SPA-fallback pattern as §11.107/108/110.
  // Move the method gate inside as an explicit 405 return so non-GET
  // requests get the structured envelope instead of HTML.
  if (url.pathname.startsWith('/api/html/preview/')) {
    if (request.method !== 'GET') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'GET required',
          channel: url.pathname,
          allow: 'GET',
        },
      })
      return
    }
  }
  if (url.pathname.startsWith('/api/html/preview/') && request.method === 'GET') {
    const rawId = url.pathname.slice('/api/html/preview/'.length).split('/')[0]
    // no initializer: every path either assigns below or returns from the
    // catch, matching the channel decode just below this block
    let id: string
    try {
      id = rawId ? decodeURIComponent(rawId) : ''
    } catch {
      // `decodeURIComponent('%')` throws URIError; unchecked it was another way
      // to kill the process from a single request.
      sendJson(response, 400, {
        error: { message: 'Invalid preview id encoding', code: 'INVALID_ARGUMENT' },
      })
      return
    }
    const text = getHtmlPreviewBuffer(id)
    if (!text) {
      sendJson(response, 404, { error: { message: 'Preview buffer not found' } })
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // the preview iframe is sandboxed (no allow-same-origin); the buffer
      // itself runs scripts and links to any CDN/asset it references.
      'Content-Security-Policy':
        "default-src 'self' 'unsafe-inline' data: blob: https: http:; media-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self';",
    })
    response.end(text)
    return
  }

  if (url.pathname.startsWith('/api/ipc/') && request.method === 'POST') {
    // sdk1 §11.110: skip /api/ipc/events — it's a GET-only SSE endpoint with
    // its own dedicated handler below that emits the proper 405 envelope for
    // POST/PUT/DELETE. Without this carve-out the broader POST catch-all would
    // interpret the trailing `events` segment as an IPC channel name and
    // return 404 (IPC_NO_HANDLER) instead of the expected 405.
    if (url.pathname === '/api/ipc/events') {
      // fall through to the dedicated GET-only handler below
    } else {
    const encodedChannel = url.pathname.slice('/api/ipc/'.length)
    let channel: string
    try {
      channel = decodeURIComponent(encodedChannel)
    } catch {
      sendJson(response, 400, {
        error: { message: 'Invalid IPC channel encoding', code: 'IPC_INVALID_CHANNEL' },
      })
      return
    }
    const session = request.headers['x-ipc-session'] as string | undefined

    let decodedArgs: unknown[]
    try {
      const body = await readBody(request)
      // A malformed body is the caller's fault, not a server fault. Catch the
      // SyntaxError here so `sendIpcError` sees a structured INVALID_ARGUMENT
      // (400) instead of the raw `Unexpected token …` 500 a JSON.parse throw
      // would otherwise become.
      let parsed: { args?: unknown[] }
      try {
        parsed = JSON.parse(body || '{}') as { args?: unknown[] }
      } catch {
        throw new InvalidArgumentError(channel, 'request body is not valid JSON')
      }
      // sdk1 §11.108: args MUST be an array. Previously the code cast
      // `parsed.args ?? []` to `unknown[]` and called `.map(...)` on it;
      // a caller-supplied `{ args: "not-an-array" }` would throw
      // `args.map is not a function` and bubble up as a 500 INTERNAL
      // exposing an internal JS error to the host. Validate here so the
      // failure mode is a clean 400 with the same channel-bound error
      // shape as every other v1 / IPC failure path.
      if (parsed.args !== undefined && !Array.isArray(parsed.args)) {
        throw new InvalidArgumentError(channel, '`args` must be an array')
      }
      const args = parsed.args ?? []
      decodedArgs = args.map((arg) => decodeTransportValue(arg))

      const entry = getHandlerEntry(channel)
      if (entry) {
        // Scope gate (sdk1 §A.5 #10 audit:log close, §11.78 expansion):
        // if the handler opted into a scope and the caller presented an
        // `Authorization: Bearer …` header, run the gate the v1 REST layer
        // uses. Requests without an Authorization header fall through to
        // the legacy trust model (WEB_TOKEN-cookie or no-auth dev mode) so
        // the in-process renderer stack keeps working without minting a
        // JWT for every UI-driven channel. Channels without scope metadata
        // never gate, regardless of auth.
        if (entry.scope) {
          // Scope gate policy (§11.78):
          //   - "hard" scopes (any string NOT starting with `soft:`) require
          //     an Authorization header. No header → 401 UNAUTHENTICATED.
          //     This matches the v1 REST layer and protects enterprise /
          //     admin-only channels that should never be reachable from
          //     the unauthenticated renderer stack.
          //   - "soft" scopes (prefixed `soft:`) are skipped when the
          //     caller presents no Authorization header — the call falls
          //     through to the legacy trust model (WEB_TOKEN-cookie or
          //     no-auth dev mode) — but enforced normally when the caller
          //     does present a token. This lets us add scope protection
          //     to renderer-driven UI channels (marketplace / update /
          //     user-prefs) without breaking the in-process web UI which
          //     historically did not mint a JWT.
          const isSoft = entry.scope.startsWith('soft:')
          const effectiveScope = isSoft ? entry.scope.slice('soft:'.length) : entry.scope
          if (!isSoft) {
            const gate = requireScopeFromHeaders(request.headers, effectiveScope)
            if (!gate.ok) {
              sendJson(response, gate.status, {
                error: { code: gate.code, message: gate.message, channel },
              })
              return
            }
          } else if (hasAuthorizationHeader(request.headers)) {
            const gate = requireScopeFromHeaders(request.headers, effectiveScope)
            if (!gate.ok) {
              sendJson(response, gate.status, {
                error: { code: gate.code, message: gate.message, channel },
              })
              return
            }
          }
        }
        // Pass the SSE session id + JWT subject through to handlers via the
        // event object so they can look up per-session state (currentSlidesPath,
        // dirty tracking, etc.) and stamp audit records with the real caller.
        // The id on sender stays -1 because there is no 1:1 webSocket — the
        // real session key is the SSE channel. userId is best-effort: when
        // no Authorization header is present (legacy renderer stack, dev
        // mode), userId is undefined and audit:log falls back to its
        // caller-supplied arg or 'system'. §11.92 wires this so audit
        // records stop carrying 'system' for every authenticated caller.
        const authPayload = hasAuthorizationHeader(request.headers)
          ? verifyJwtWithRevocation(
              ((request.headers as { authorization?: string }).authorization ?? '').slice('Bearer '.length),
            )
          : null
        const event = {
          processId: 0,
          frameId: 0,
          sessionId: session,
          ...(authPayload?.sub ? { userId: authPayload.sub } : {}),
          sender: {
            id: -1,
            isDestroyed: () => false,
            send: (ch: string, ...a: unknown[]) => {
              const encodedArgs = a.map((arg) => encodeTransportValue(arg))
              if (session) pushSseEvent(session, ch, encodedArgs)
            },
          },
        }

        const result = await entry.handler(event, ...decodedArgs)
        const encodedResult = encodeTransportValue(result)
        sendJson(response, 200, { ok: true, result: encodedResult })
      } else {
        sendJson(response, 404, {
          error: { message: `No handler for '${channel}'`, code: 'IPC_NO_HANDLER' },
        })
      }
    } catch (error) {
      sendIpcError(response, error, true, channel)
    }
    return
    }
  }

  if (url.pathname === '/api/ipc/events') {
    if (request.method !== 'GET') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'GET required',
          channel: url.pathname,
          allow: 'GET',
        },
      })
      return
    }
    const session = url.searchParams.get('session')
    if (!session) {
      sendJson(response, 400, { error: { message: 'Missing session' } })
      return
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write(': connected\n\n')

    const pending = PENDING_FRAMES.get(session)
    if (pending) {
      for (const frame of pending) response.write(frame)
      PENDING_FRAMES.delete(session)
    }

    if (!sessionConnections.has(session)) {
      sessionConnections.set(session, new Set())
    }
    sessionConnections.get(session)!.add(response)

    const heartbeat = setInterval(() => {
      try {
        response.write(': heartbeat\n\n')
      } catch {
        clearInterval(heartbeat)
      }
    }, SSE_HEARTBEAT_MS)

    // Single teardown path so a client navigating away (or a heartbeat write
    // failing on a dead socket) ends the chunked stream cleanly instead of
    // leaving the browser to log ERR_INCOMPLETE_CHUNKED_ENCODING.
    let closed = false
    const teardown = () => {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      sessionConnections.get(session)?.delete(response)
      if (sessionConnections.get(session)?.size === 0) {
        sessionConnections.delete(session)
      }
      try {
        response.end()
      } catch {
        // socket already gone
      }
    }

    request.on('close', teardown)
    request.on('aborted', teardown)
    response.on('close', teardown)
    return
  }

  if (url.pathname === '/api/ai/stream') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    let sessionAbort: AbortController | undefined
    let requestId: string | undefined
    try {
      const body = await readBody(request)
      let req: {
        requestId?: string
        sessionId?: string
        settings?: AiSettings
        system?: string
        messages?: Parameters<typeof runProviderStream>[2]
        tools?: Parameters<typeof runProviderStream>[3]
        maxTokens?: number
      }
      try {
        req = JSON.parse(body || '{}') as typeof req
      } catch {
        // Translate the raw SyntaxError into the standard INVALID_ARGUMENT
        // shape that the rest of the API returns for malformed bodies.
        // Without this the caller sees `Unexpected token 'o', ... is not
        // valid JSON` as a 500.
        throw new InvalidArgumentError('/api/ai/stream', 'request body is not valid JSON')
      }
      const streamId =
        req.requestId || `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      requestId = streamId
      // Import inside the handler to grab the live settings the AI module
      // has just persisted (avoids a duplicate cached copy).
      const { aiSettings: aiSettingsFallback } = (await import('./ai/index')) as {
        aiSettings: AiSettings
      }
      // The renderer can include its own settings override; otherwise use
      // the server's persisted ones.
      const chatMod = (await import('./ai/chat' as string).catch(() => null)) as {
        aiSettings?: AiSettings
      } | null
      const settings: AiSettings =
        (req.settings as AiSettings | undefined) ?? chatMod?.aiSettings ?? aiSettingsFallback

      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': streamId,
      })

      const send = (chunk: AiStreamChunk) => {
        try {
          response.write(`data: ${JSON.stringify({ ...chunk, requestId: streamId })}\n\n`)
        } catch (error) {
          // Client disconnected mid-stream: abort the upstream call so we
          // don't keep producing tokens into the void.
          sessionAbort?.abort()
        }
      }

      // Track the session so /api/ai/stream/cancel can abort it.
      sessionAbort = new AbortController()
      AI_STREAM_SESSIONS.set(streamId, { abort: sessionAbort, chunks: 0 })

      // If the client disconnects, stop the upstream call too.
      request.on('close', () => {
        sessionAbort?.abort()
        AI_STREAM_SESSIONS.delete(streamId)
      })

      await runProviderStream(
        settings,
        req.system || '',
        req.messages || [],
        req.tools || [],
        req.maxTokens ?? undefined,
        {
          onAbort: (c) => {
            sessionAbort = c
          },
          send,
        },
      )
    } catch (error) {
      // Two failure windows exist on this endpoint. Before `writeHead` the
      // raw JS error must NOT reach the wire — JSON.parse errors look like a
      // server fault to the caller and should be classified as a 400 with
      // the same shape every other malformed request uses. After the 200 SSE
      // header has been flushed, calling `sendIpcError` would attempt to
      // write another header on a streaming response, raising
      // ERR_HTTP_HEADERS_SENT and silently hanging the chunked stream. The
      // only correct teardown in that case is a final `error` SSE event
      // followed by `end()` (handled by the finally block below).
      if (response.headersSent) {
        sendSseError(response, error, requestId)
      } else {
        sendIpcError(response, error)
      }
      sessionAbort?.abort()
    } finally {
      try {
        response.end()
      } catch (error) {
        // Already closed by the peer or by a prior error; nothing to do.
      }
    }
    return
  }

  if (url.pathname === '/api/ai/stream/cancel') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    let requestId: string | undefined
    try {
      const body = await readBody(request)
      try {
        ;({ requestId } = JSON.parse(body || '{}') as { requestId?: string })
      } catch {
        throw new InvalidArgumentError('/api/ai/stream/cancel', 'request body is not valid JSON')
      }
      if (!requestId) {
        sendJson(response, 400, { error: { message: 'requestId required' } })
        return
      }
      const session = AI_STREAM_SESSIONS.get(requestId)
      if (session) {
        session.abort.abort()
        AI_STREAM_SESSIONS.delete(requestId)
      }
      sendJson(response, 200, { ok: true, aborted: !!session })
    } catch (error) {
      sendIpcError(response, error)
    }
    return
  }

  // GET /api/ai/languages — canonical translation language catalogue shared
  //   with Dataflarework (the static list lives in @genoffice/translation-core;
  //   see apps/web-server/src/ai/languages-http.ts for the design rationale).
  if (url.pathname === '/api/ai/languages') {
    handleLanguagesHttp(request, response)
    return
  }

  if (url.pathname === '/api/ai/translate') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    void handleTranslateBatchHttp(request, response)
    return
  }

  if (url.pathname === '/api/ai/translate/stream') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    void handleTranslateStreamHttp(request, response)
    return
  }

  if (url.pathname === '/api/ai/translate/stream/cancel') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    void handleTranslateStreamCancelHttp(request, response)
    return
  }

  // POST /api/ai/pi-prompt — drives the embedded pi AgentSession. The renderer
  // POSTs { text } and receives a `text/event-stream` of AgentSessionEvents
  // (agent_start, message_update, tool_call, tool_result, agent_end). This is
  // the channel the GenOffice UI uses when the user wants the agent to drive
  // translation through the SKILL.md wrappers instead of through the TS path,
  // and it is also the foundation for a future in-shell agent panel.
  // sdk1 §11.107: GET /api/ai/pi-prompt must return 405 instead of
  // falling through to the SPA fallback (which served HTML).
  if (url.pathname === '/api/ai/pi-prompt') {
    if (request.method !== 'POST') {
      sendJson(response, 405, {
        error: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'POST required',
          channel: url.pathname,
          allow: 'POST',
        },
      })
      return
    }
    void handlePiPromptStreamHttp(request, response)
    return
  }

  // /favicon.ico — the browser always asks for it; serve the bundled app
  // icon so the console stops logging a 404 every page load. The icon lives
  // at apps/shell/build/icon.png relative to STATIC_ROOT.
  if (url.pathname === '/favicon.ico') {
    const faviconPath = resolve(STATIC_ROOT, 'shell', 'build', 'icon.png')
    if (existsSync(faviconPath)) {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      createReadStream(faviconPath).pipe(response)
      return
    }
    response.writeHead(204)
    response.end()
    return
  }

  // ----- iframe Embed endpoint (`/embed/:docId?token=...`) -----------------
  // Stable v1 surface — see sdk1.md §2.1.C. Must run BEFORE the SPA fallback
  // so the embed wrapper page wins over the shell home tab when a caller
  // mounts `/embed/…` against a deployment that doesn't strip the prefix.
  // sdk1 §11.109: handle ALL methods here so the embed handler can
  // return 405 for non-GET (POST / PUT / DELETE). Previously the gate
  // `request.method === 'GET'` made non-GET fall through to the SPA
  // fallback which returned 200 + <!doctype html>.
  if (url.pathname.startsWith('/embed/')) {
    if (handleEmbed(request, response, url)) return
  }

  // ----- static / SPA fallback ---------------------------------------------
  // sdk1 §11.112 (continuation): SPA sub-routes (/docs, /sheets, /slides,
  // /pdf, /markdown, /html, /shell, /, /manage, /management) are HTML
  // pages. Browsers only fetch them with GET (or HEAD for resource
  // discovery). POST / PUT / DELETE / PATCH previously fell through to
  // the static fallback which served index.html with 200 + Content-Type
  // text/html — same SPA-fallback-on-wrong-method bug class as
  // §11.107 / §11.108 / §11.110 / §11.111. The static layer returns 405
  // for any non-GET / non-HEAD method; let the registered API handlers
  // above (or the inner SPA missing-asset 404 below) handle the GET case
  // unchanged.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'static / SPA subroutes are GET-only',
        channel: url.pathname,
        allow: 'GET, HEAD',
      },
    })
    return
  }
  const pathMatch = url.pathname.match(
    /^\/(docs|sheets|slides|pdf|markdown|html|shell)(?:\/(.*))?$/,
  )
  // `/` is the management route ONLY when the caller did not pin a specific
  // app — `/?app=docs` must reach the docs bundle, not the shell home tab.
  // Without this guard every sub-page (`/?app=docs`, `/?app=sheets`, …) used
  // to fall through to apps/shell/out/renderer/index.html and never reached
  // its own renderer bundle. Same for `/manage` and `/management`: only the
  // bare path counts; a `?app=` override is honored.
  const hasAppHint = url.searchParams.has('app') || pathMatch !== null
  const isManagementRoute =
    !hasAppHint &&
    (url.pathname === '/' || url.pathname === '/manage' || url.pathname === '/management')
  // The app segment is request-controlled `?app=`, so it goes through the APPS
  // allow-list. Unvalidated, `?app=../../../../etc` walked out of the static
  // root and every `<anywhere>/out/renderer/*` file became readable.
  const requestedApp = url.searchParams.get('app') || pathMatch?.[1] || 'shell'
  const appName = isManagementRoute ? 'shell' : APPS.includes(requestedApp) ? requestedApp : 'shell'
  // `pathMatch[2]` keeps whatever followed the route name and may start with a
  // slash (`/docs//etc/passwd` captures `/etc/passwd`). Strip leading slashes
  // before any join so the path can never be read as absolute.
  const rawRelative = pathMatch
    ? pathMatch[2] || 'index.html'
    : url.pathname.replace(/^\/+/, '') || 'index.html'
  const relativePath = rawRelative.replace(/^[/\\]+/, '') || 'index.html'
  let filePath = resolveRendererFile(appName, relativePath)
  // A computed-but-missing path means "not found": clear it so `filePath` stays
  // a truthful found/missing signal for every fallback below. Assigning the
  // docs candidate unconditionally used to leave `filePath` truthy even when
  // that candidate did not exist, which skipped both the route-prefix retry and
  // the cross-app asset search further down. The visible effect: `/?app=pdf`
  // served the pdf HTML and then 404'd its own bundle, because a relative
  // `./assets/*` drops the query string, so the asset request is inferred as
  // `shell` and the miss never reached the search that would have found it.
  if (filePath && !existsSync(filePath)) filePath = null

  if (!filePath) {
    const docsCandidate = resolveRendererFile('docs', relativePath)
    if (docsCandidate && existsSync(docsCandidate)) filePath = docsCandidate
  }

  // SPA sub-routes such as /marketplace/ and /skills/ are rendered by the
  // shell bundle but keep their route name as a path prefix, so their module
  // requests arrive as /marketplace/assets/index-*.js. Without this the file
  // is not found and the SPA index.html is returned instead, which the browser
  // rejects ("Expected a JavaScript-or-Wasm module script but the server
  // responded with a MIME type of text/html"). Retry every app with the
  // leading route segment stripped so the module is served with its real
  // MIME type. Only files are accepted so a stripped path can never resolve
  // to a renderer directory.
  if (!filePath || !existsSync(filePath)) {
    const stripped = relativePath.replace(/^[^/]+\//, '')
    if (stripped && stripped !== relativePath) {
      for (const candidateApp of APPS) {
        const candidatePath = resolveRendererFile(candidateApp, stripped)
        if (candidatePath && existsSync(candidatePath) && statSync(candidatePath).isFile()) {
          filePath = candidatePath
          break
        }
      }
    }
  }

  if ((!filePath || !existsSync(filePath)) && relativePath.startsWith('assets/')) {
    for (const candidateApp of APPS) {
      const candidatePath = resolveRendererFile(candidateApp, relativePath)
      if (candidatePath && existsSync(candidatePath)) {
        filePath = candidatePath
        break
      }
    }
  }

  if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath)
    const isHtml = ext.toLowerCase() === '.html'
    if (isHtml && process.env.WEB_TOKEN) {
      // Inject the WEB_TOKEN into the page so the renderer's HTTP IPC
      // transport can send it back on every same-origin request. Without
      // this, a WEB_TOKEN-configured server returns 401 on every IPC call
      // because the browser-built transport has no way to learn the token.
      // The token rides on a `<meta>` tag rather than an inline script
      // because the SPA's CSP is `script-src 'self'` — an injected
      // `<script>` would be silently dropped and the renderer would never
      // see the value. The renderer reads it from
      // `document.querySelector('meta[name="genoffice-token"]')`.
      const html = readFileSync(filePath, 'utf-8')
      const tag = `\n<meta name="genoffice-token" content="${process.env.WEB_TOKEN.replace(/"/g, '&quot;')}">`
      const cookie = authCookieHeader()
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'text/html; charset=utf-8',
        ...(cookie ? { 'Set-Cookie': cookie } : {}),
      })
      response.end(html.replace(/<\/head>/i, (_match) => `${tag}</head>`))
      return
    }
    response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
    createReadStream(filePath).pipe(response)
    return
  }

  // A static asset we could not resolve must not be answered with the SPA
  // index.html: the browser sees `text/html` for a `.js`/`.css` request and
  // refuses to execute it ("Expected a JavaScript-or-Wasm module script but
  // the server responded with a MIME type of text/html") — the exact failure
  // that broke /marketplace/ before the prefix retry above. Answering 404
  // makes the miss explicit so the SPA can surface a real error instead of a
  // MIME mismatch. Extension-less requests still fall through to the SPA so
  // client-side routing keeps working.
  const requestedExt = extname(relativePath).toLowerCase()
  if (requestedExt && requestedExt !== '.html' && requestedExt in MIME_TYPES) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(`Not found: ${url.pathname}`)
    return
  }

  const indexPath = resolve(STATIC_ROOT, appName, 'out', 'renderer', 'index.html')
  if (existsSync(indexPath)) {
    if (process.env.WEB_TOKEN) {
      // Same-origin auth shim: see the direct-file branch above for the
      // rationale. The meta-tag injection is CSP-safe because
      // `script-src 'self'` would otherwise drop the value before the
      // renderer could read it.
      const html = readFileSync(indexPath, 'utf-8')
      const tag = `\n<meta name="genoffice-token" content="${process.env.WEB_TOKEN.replace(/"/g, '&quot;')}">`
      const cookie = authCookieHeader()
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...(cookie ? { 'Set-Cookie': cookie } : {}),
      })
      response.end(html.replace(/<\/head>/i, (_match) => `${tag}</head>`))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    createReadStream(indexPath).pipe(response)
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(
    `<!doctype html><meta charset="utf-8"><title>GenOffice Web Server</title>` +
      `<style>body{font-family:system-ui;max-width:640px;margin:48px auto;padding:0 24px;color:#222;line-height:1.55}` +
      `code{background:#f4f4f4;padding:2px 6px;border-radius:3px;font-size:0.92em}</style>` +
      `<h1>GenOffice Web Server</h1>` +
      `<p>The renderer apps were not found at <code>${STATIC_ROOT}</code>.</p>` +
      `<p>Either run <code>npm run build:all</code> at the repo root and keep it on the same disk layout, ` +
      `or set <code>WEB_STATIC_ROOT=/path/to/apps</code> to point at an apps directory you mounted.</p>`,
  )
  } catch (err) {
    // sdk1 §11.121: outer safety net. Log full error for the operator;
    // answer a structured 500 envelope so the client does NOT hang.
    console.error('[genoffice] uncaught request error:', err)
    if (!response.headersSent) {
      try {
        response.writeHead(500, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          error: {
            message: 'internal server error',
            code: 'INTERNAL',
          },
        }))
      } catch {
        /* socket already closed */
      }
    }
  }
})

// Detect whether the renderer apps are available at STATIC_ROOT. When the
// binary is shipped standalone (pkg) the operator is expected to set
// WEB_STATIC_ROOT; in dev the apps live next to the source. We surface
// this in the boot log so misconfiguration is obvious instead of silent.
const shellIndex = resolve(STATIC_ROOT, 'shell', 'out', 'renderer', 'index.html')
const staticReady = existsSync(shellIndex)
const staticHint = staticReady
  ? `║   📁 Static root: ${STATIC_ROOT}                    ║\n`
  : `║   ⚠️  No renderer apps at ${STATIC_ROOT}          ║\n` +
    `║      Set WEB_STATIC_ROOT=/path/to/apps or run npm run build:all  ║\n`

server.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   GenOffice Web Server v${WEB_SERVER_VERSION} (Enhanced)         ║
║                                                           ║
    URL: http://${HOST}:${PORT}
║   📁 Mode: Standalone (No Electron)                        ║
║                                                           ║
║   Apps: ${APPS.slice(0, 4).join(', ')}...
${staticHint}║                                                           ║
║   📊 Channels: ${String(handlerCount()).padEnd(25)}   ║
║   🔗 Features: AI, Collab, Files, Projects, AnyDoc        ║
║                                                           ║
║   Endpoints:                                              ║
║   • GET  /health              Health check                 ║
║   • GET  /api/channels       List channels                ║
║   • POST /api/ai/stream       Agent Loop SSE               ║
║   • GET  /api/collab/sessions Collaboration status        ║
║   • POST /api/ipc/:channel   IPC invoke                  ║
║   • GET  /api/ipc/events     SSE events                  ║
║                                                           ║
║   Agent Core Integration:                                 ║
║   ✅ createHttpTransport()  - HTTP Transport for AgentLoop ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
`)
})

/**
 * Persist anything the translation memory is still holding before we exit.
 *
 * `PersistentTranslationMemory.save()` only marks the language pair dirty and
 * the handlers flush on a 250 ms debounce, so a translation made in the last
 * moments before shutdown — or a signal that lands between the save and its
 * flush timer — was lost. Imported lazily because `ai/chat.ts` is heavy.
 */
function flushTranslationMemory(): Promise<void> {
  return import('./ai/chat').then((mod) => mod.flushTranslationMemory()).catch(() => undefined)
}

function shutdown(code = 0): void {
  /* Both writers are debounced, so a signal in the last few hundred
   * milliseconds would otherwise discard the recents entries and file ids the
   * user just created. Flush them before the server stops accepting
   * connections, and only then close. */
  const flushState = async (): Promise<void> => {
    try {
      await fileIndexStore.flushNow()
    } catch {
      /* a failed flush during shutdown must not block the exit path */
    }
    flushFileManagementState()
  }
  void Promise.allSettled([flushTranslationMemory(), flushState()]).finally(() => {
    server.close(() => process.exit(code))
  })
}

process.on('SIGTERM', () => shutdown())
process.on('SIGINT', () => shutdown())

/**
 * SSE bridge to the embedded pi AgentSession. We lazy-import `pi-session` so
 * the cost of building the agent (model runtime + resource loader) is paid on
 * first use, not at server start.
 */
async function handlePiPromptStreamHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const { getPiSession, invalidatePiSession } = (await import('./shell/pi-session')) as {
    getPiSession: () => Promise<{
      session: {
        prompt: (text: string, options?: Record<string, unknown>) => Promise<void>
        subscribe: (listener: (event: Record<string, unknown>) => void) => () => void
      }
    }>
    invalidatePiSession: () => void
  }

  // no initializers: the catch below returns before either is read, and each
  // is read only after its assignment in the streaming try block
  let promptText: string
  let dropped = false
  try {
    const body = await readBody(request)
    const req = JSON.parse(body || '{}') as { text?: string }
    promptText = String(req.text ?? '').trim()
  } catch {
    // sdk1 §11.107: align with v1 envelope `{ error: { code, message, channel } }`
    // instead of `{ ok: false, error: "..." }` so callers can branch on
    // `error.code` consistently with every other v1 + legacy endpoint.
    sendJson(response, 400, {
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'pi-prompt: invalid JSON body',
        channel: '/api/ai/pi-prompt',
      },
    })
    return
  }
  if (!promptText) {
    sendJson(response, 400, {
      error: {
        code: 'INVALID_ARGUMENT',
        message: 'pi-prompt: empty text',
        channel: '/api/ai/pi-prompt',
      },
    })
    return
  }

  const streamId = `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Request-Id': streamId,
  })

  const send = (chunk: Record<string, unknown>) => {
    if (dropped) return
    try {
      response.write(`data: ${JSON.stringify({ ...chunk, requestId: streamId })}\n\n`)
    } catch {
      dropped = true
    }
  }

  let officeSession: Awaited<ReturnType<typeof getPiSession>>
  let unsubscribe: (() => void) | null = null

  const teardown = () => {
    if (unsubscribe) {
      try {
        unsubscribe()
      } catch {
        /* ignore */
      }
      unsubscribe = null
    }
  }
  request.on('close', teardown)
  request.on('aborted', teardown)
  response.on('close', teardown)

  try {
    send({ type: 'start', requestId: streamId, text: promptText })
    officeSession = await getPiSession()
    // Translate pi AgentSessionEvent → a flat SSE-friendly shape.
    unsubscribe = officeSession.session.subscribe((event) => {
      const e = event as { type?: string } & Record<string, unknown>
      switch (e.type) {
        case 'agent_start':
          send({ type: 'agent_start' })
          break
        case 'message_update':
          send({ type: 'message_update', message: e.message })
          break
        case 'tool_call':
          send({
            type: 'tool_call',
            toolName: e.toolName,
            args: e.args,
            toolCallId: e.toolCallId,
          })
          break
        case 'tool_result':
          send({
            type: 'tool_result',
            toolName: e.toolName,
            result: e.result,
            isError: e.isError,
            toolCallId: e.toolCallId,
          })
          break
        case 'turn_end':
          send({ type: 'turn_end', message: e.message, toolCalls: e.toolCalls })
          break
        case 'agent_end':
          send({ type: 'agent_end', messages: e.messages })
          break
        default:
          // Forward every other event verbatim so the client can render it.
          send({ type: e.type ?? 'unknown', event: e })
      }
    })
    await officeSession.session.prompt(promptText)
    send({ type: 'complete', requestId: streamId })
  } catch (error) {
    send({
      type: 'error',
      requestId: streamId,
      message: error instanceof Error ? error.message : String(error),
    })
    // If the agent itself is broken, drop the session so the next call rebuilds.
    try {
      invalidatePiSession()
    } catch {
      /* ignore */
    }
  } finally {
    teardown()
    try {
      response.end()
    } catch {
      /* ignore */
    }
  }
}
