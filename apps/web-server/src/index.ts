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
import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'

import {
  APPS,
  COLLAB_SESSIONS,
  HOST,
  MIME_TYPES,
  PORT,
  STATIC_ROOT,
  decodeTransportValue,
  initRecentState,
  encodeTransportValue,
  getHandler,
  handlerCount,
  listChannels,
} from './common/index'
import { registerAiHandlers, AI_STREAM_SESSIONS, runProviderStream } from './ai/index'
import { classifyWebError, ipcErrorStatus, InvalidArgumentError } from './ai/errors'
import {
  handleTranslateBatchHttp,
  handleTranslateStreamHttp,
  handleTranslateStreamCancelHttp,
} from './ai/translate-http'
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

// ----- global error traps (must run before any handler so unexpected
//       failures in the pi session bridge show a stack instead of dying silently)
process.on('uncaughtException', (err) => {
  console.error('[genoffice] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[genoffice] unhandledRejection:', reason)
})

// ----- capability wiring ----------------------------------------------------
initRecentState()
registerAiHandlers()
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

// ----- HTTP helpers --------------------------------------------------------
function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
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

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

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

  if (url.pathname === '/health' && request.method === 'GET') {
    sendJson(response, 200, {
      status: 'ok',
      version: '0.8.0',
      mode: 'web-server',
      implementedChannels: handlerCount(),
      features: ['ai', 'collab', 'files', 'projects'],
    })
    return
  }

  if (url.pathname === '/api/channels' && request.method === 'GET') {
    sendJson(response, 200, { channels: listChannels() })
    return
  }

  if (url.pathname === '/api/collab/sessions' && request.method === 'GET') {
    const sessions = [...COLLAB_SESSIONS.entries()].map(([docId, session]) => ({
      docId,
      users: [...session.users],
      lastActivity: session.lastActivity,
    }))
    sendJson(response, 200, { sessions })
    return
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
      const args = parsed.args ?? []
      decodedArgs = (args as unknown[]).map((arg) => decodeTransportValue(arg))

      const handler = getHandler(channel)
      if (handler) {
        const event = {
          processId: 0,
          frameId: 0,
          sender: {
            id: -1,
            isDestroyed: () => false,
            send: (ch: string, ...a: unknown[]) => {
              const encodedArgs = a.map((arg) => encodeTransportValue(arg))
              if (session) pushSseEvent(session, ch, encodedArgs)
            },
          },
        }

        const result = await handler(event, ...decodedArgs)
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

  if (url.pathname === '/api/ipc/events' && request.method === 'GET') {
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

  if (url.pathname === '/api/ai/stream' && request.method === 'POST') {
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

  if (url.pathname === '/api/ai/stream/cancel' && request.method === 'POST') {
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

  if (url.pathname === '/api/ai/translate' && request.method === 'POST') {
    void handleTranslateBatchHttp(request, response)
    return
  }

  if (url.pathname === '/api/ai/translate/stream' && request.method === 'POST') {
    void handleTranslateStreamHttp(request, response)
    return
  }

  if (url.pathname === '/api/ai/translate/stream/cancel' && request.method === 'POST') {
    void handleTranslateStreamCancelHttp(request, response)
    return
  }

  // POST /api/ai/pi-prompt — drives the embedded pi AgentSession. The renderer
  // POSTs { text } and receives a `text/event-stream` of AgentSessionEvents
  // (agent_start, message_update, tool_call, tool_result, agent_end). This is
  // the channel the GenOffice UI uses when the user wants the agent to drive
  // translation through the SKILL.md wrappers instead of through the TS path,
  // and it is also the foundation for a future in-shell agent panel.
  if (url.pathname === '/api/ai/pi-prompt' && request.method === 'POST') {
    void handlePiPromptStreamHttp(request, response)
    return
  }

  // ----- static / SPA fallback ---------------------------------------------
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
║   GenOffice Web Server v0.8.0 (Enhanced)                ║
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
  void flushTranslationMemory().finally(() => {
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
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'pi-prompt: invalid JSON body' }))
    return
  }
  if (!promptText) {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: false, error: 'pi-prompt: empty text' }))
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
