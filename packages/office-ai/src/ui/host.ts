/**
 * Loopback UI host — the HTTP face the office-ai library exposes so a real
 * renderer bundle (apps/<app>/out/renderer) boots in a browser and talks to
 * office-ai handlers over the same JSON-over-HTTP IPC contract as
 * apps/web-server. Two binding modes share this one request handler:
 *
 *  - startUiHost(): self-binds 127.0.0.1:<ephemeral> (lifecycle tied to close()).
 *  - attachUi(server, { basePath }): middleware on the host's own http.Server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'

import { OfficeError } from '../errors'
import type { AiSettings } from '@genoffice/ai-provider'
import { resolveAiHostSettings, type AiHostSettings } from './ai-settings'
import { handleAiStream } from './ai-stream'
import { createRegistry, type Registry } from './registry'
import { SseHub } from './sse-hub'
import { createAssetsResolver, type AssetsResolver, type UiApp } from './assets'
import { createWorkspace, type PathAccess, type Workspace } from './workspace'
import { createEmbedState, handleEmbed, registerSdkCommandHandlers, resolveFrameAncestors, type EmbedState } from './embed'
import { registerAppChannels } from './handlers/app-channels'
import { createDocsState, registerDocsHandlers, type DocsHandlerState } from './handlers/docs'
import { createSheetsState, registerSheetsHandlers, type SheetsHandlerState } from './handlers/sheets'
import {
  createSlidesState,
  registerSlidesHandlers,
  type SlidesState,
} from './handlers/slides'
import { registerPdfHandlers } from './handlers/pdf'
import { MAX_HTTP_BODY_BYTES, readBodyWithCap } from './read-body'
import { serveStaticFile } from './static-serve'
import { decodeTransportValue, encodeTransportValue } from './codec'
import { ipcErrorStatus, sendIpcErrorPayload } from './ipc-errors'
import { buildChannelsView } from './channels-view'
import { MIME_TYPES } from './mime'

export interface UiHostContext {
  registry: Registry
  sse: SseHub
  assets: AssetsResolver
  workspace: Workspace
  docs: DocsHandlerState
  sheets: SheetsHandlerState
  slides: SlidesState
  /** SDK comments / version index / usage totals for the embed bridge. */
  embed: EmbedState
  /**
   * Authoritative provider config for `POST /api/ai/stream`. Resolved from the
   * `ai` option; a host started without one still gets the full provider
   * catalog so the renderer's settings UI is coherent, but every call is
   * refused with a readable reason instead of reaching a provider.
   */
  ai: AiSettings
  /** When set, /api/** must carry it (Bearer header or ?token=). */
  token: string | null
  apps: readonly UiApp[]
  basePath: string
  /** Validated `frame-ancestors` value sent with every `/embed/:docId` page. */
  frameAncestors: string
}

export interface CreateHostContextOptions {
  assetsDir?: string
  token?: string
  apps?: readonly UiApp[]
  basePath?: string
  /** Workspace root for staged documents/temp files; default a fresh temp dir. */
  workspaceDir?: string
  /** Renderer-supplied path policy: 'workspace' (default) or 'any'. */
  pathAccess?: PathAccess
  /**
   * `frame-ancestors` for `/embed/:docId`, e.g. `'http://127.0.0.1:3000'`.
   *
   * The wrapper page exists to be framed, so when the consumer's page is on a
   * different origin — every `startUiHost()` deployment, since the host binds
   * its own loopback port — the default `'self'` refuses the frame and the
   * iframe stays empty with no client-side error. Name the embedding origin(s)
   * here. Falls back to `EMBED_FRAME_ANCESTORS` when unset.
   */
  frameAncestors?: string
  /**
   * Provider credentials for the renderer's AI panel.
   *
   * Required for AI to work at all: the renderer's web transport sends no
   * provider selection (see ai-settings.ts), so this is the only config the
   * host has. Without it `/api/ai/stream` answers every request with an
   * `error` frame naming what is missing — never a 404.
   */
  ai?: AiHostSettings
}

export function createHostContext(options: CreateHostContextOptions = {}): UiHostContext {
  const basePath = normalizeBasePath(options.basePath ?? '/')
  const workspace = createWorkspace({ dir: options.workspaceDir, pathAccess: options.pathAccess })
  const context: UiHostContext = {
    registry: createRegistry(),
    sse: new SseHub(),
    assets: createAssetsResolver(options.assetsDir),
    workspace,
    docs: createDocsState(),
    sheets: createSheetsState(),
    slides: createSlidesState(),
    embed: createEmbedState(),
    ai: resolveAiHostSettings(options.ai),
    token: options.token ?? null,
    apps: options.apps ?? ['docs', 'sheets', 'slides', 'pdf'],
    basePath,
    frameAncestors: resolveFrameAncestors(options.frameAncestors),
  }
  registerAppChannels(context.registry, context.ai)
  context.docs = registerDocsHandlers(context.registry, workspace, context.docs)
  context.sheets = registerSheetsHandlers(context.registry, workspace, context.sheets)
  context.slides = registerSlidesHandlers(context.registry, workspace, context.slides)
  registerPdfHandlers(context.registry, workspace)
  registerSdkCommandHandlers(context.registry, workspace, context.embed)
  return context
}

export interface HostRequestResult {
  handled: boolean
}

/**
 * The full request handler. Returns false when the request is not ours
 * (caller decides: pass-through in attach mode, 404 in loopback mode).
 */
export async function handleUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
): Promise<HostRequestResult> {
  let url = new URL(request.url ?? '/', 'http://loopback.invalid')
  let path = url.pathname
  if (ctx.basePath !== '/') {
    if (path === ctx.basePath) {
      path = '/'
    } else if (path.startsWith(ctx.basePath + '/')) {
      path = path.slice(ctx.basePath.length)
    } else {
      return { handled: false }
    }
  }

  setCors(response)

  if (path === '/health' && (request.method === 'GET' || request.method === 'HEAD')) {
    sendJson(response, 200, { ok: true })
    return { handled: true }
  }

  // `/embed/**` is answered before the app-page route below, which would
  // otherwise read `/embed/<docId>` as a request for an app named `embed`.
  // The embed router matches on the *base-stripped* pathname, so it gets a URL
  // rebuilt from `path` — in attach mode the raw pathname still carries the
  // prefix that was stripped above.
  if (path !== url.pathname) {
    url = new URL(path + url.search, 'http://loopback.invalid')
  }
  if (handleEmbed(request, response, ctx, url)) {
    return { handled: true }
  }

  if (!path.startsWith('/api/')) {
    await serveAppStatic(request, response, ctx, url, path)
    return { handled: true }
  }

  // /api/** is the privilege boundary. Loopback binding is the primary
  // isolation; an explicit token additionally gates every API request.
  if (ctx.token && !isAuthorized(url, request.headers, ctx.token)) {
    sendJson(response, 401, { error: { code: 'UNAUTHENTICATED', message: 'missing or invalid token' } })
    return { handled: true }
  }

  // The agent loop's SSE route. Placed inside the `/api/` branch so it inherits
  // basePath stripping (the renderer's transport prefixes it) and the token
  // gate, and so an unprefixed mode-B mount 404s it exactly like web-server.
  if (handleAiStream(request, response, ctx, url)) {
    return { handled: true }
  }

  if (path === '/api/channels' && request.method === 'GET') {
    const view = buildChannelsView(ctx.registry.listChannels(), {
      prefix: url.searchParams.get('prefix') ?? '',
      includeCounts: url.searchParams.get('counts') === '1',
    })
    response.writeHead(view.status, { 'Content-Type': 'application/json', ...corsHeader() })
    response.end(view.body)
    return { handled: true }
  }

  if (path === '/api/ipc/events') {
    if (request.method !== 'GET') {
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET required', allow: 'GET' } })
      return { handled: true }
    }
    const session = url.searchParams.get('session')
    if (!session) {
      sendJson(response, 400, { error: { message: 'Missing session' } })
      return { handled: true }
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeader(),
    })
    response.write(': connected\n\n')
    ctx.sse.attach(session, response)
    return { handled: true }
  }

  if (path.startsWith('/api/ipc/') && request.method === 'POST') {
    await handleIpcInvoke(request, response, ctx, path.slice('/api/ipc/'.length))
    return { handled: true }
  }

  sendJson(response, 404, { error: { code: 'NOT_FOUND', message: `No route for ${path}` } })
  return { handled: true }
}

async function handleIpcInvoke(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  encodedChannel: string,
): Promise<void> {
  let channel: string
  try {
    channel = decodeURIComponent(encodedChannel)
  } catch {
    sendJson(response, 400, { error: { code: 'IPC_INVALID_CHANNEL', message: 'Invalid IPC channel encoding' } })
    return
  }
  const session = request.headers['x-ipc-session'] as string | undefined

  try {
    const body = await readBodyWithCap(request, MAX_HTTP_BODY_BYTES)
    let parsed: { args?: unknown[] }
    try {
      parsed = JSON.parse(body || '{}') as { args?: unknown[] }
    } catch {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: request body is not valid JSON`)
    }
    if (parsed.args !== undefined && !Array.isArray(parsed.args)) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: \`args\` must be an array`)
    }
    const decodedArgs = (parsed.args ?? []).map((arg) => decodeTransportValue(arg))

    const entry = ctx.registry.getHandlerEntry(channel)
    if (!entry) {
      sendJson(response, 404, { error: { code: 'IPC_NO_HANDLER', message: `No handler for '${channel}'` } })
      return
    }

    const event = {
      processId: 0,
      frameId: 0,
      sessionId: session,
      sender: {
        id: -1,
        isDestroyed: () => false,
        send: (ch: string, ...args: unknown[]) => {
          if (session) ctx.sse.push(session, ch, args)
        },
      },
    }
    const result = await entry(event, ...decodedArgs)
    sendJson(response, 200, { ok: true, result: encodeTransportValue(result) })
  } catch (error) {
    const { status, body } = sendIpcErrorPayload(error, channel)
    sendJson(response, status, body)
  }
}

// ----- static renderer serving ----------------------------------------------

function serveAppStatic(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  url: URL,
  path: string,
): Promise<void> {
  // `<app>/…` page + asset routes, plus a bare `/` → docs index (the loopback
  // host has no shell/home tab; mounting a specific app is the primary flow).
  const pathMatch = path.match(/^\/(docs|sheets|slides|pdf)(?:\/(.*))?$/)
  const requestedApp = (pathMatch?.[1] ?? url.searchParams.get('app')) as UiApp | null
  const appName =
    requestedApp && ctx.apps.includes(requestedApp) ? requestedApp : ctx.apps[0]
  if (!appName) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('No UI apps available: pass assetsDir or install @genoffice/office-ai-ui-assets')
    return Promise.resolve()
  }

  const rawRelative = pathMatch ? pathMatch[2] || 'index.html' : url.pathname.replace(/^\/+/, '') || 'index.html'
  const relativePath = rawRelative.replace(/^[/\\]+/, '') || 'index.html'
  const appDir = ctx.assets.resolveAppDir(appName)
  if (!appDir) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(`Renderer assets for '${appName}' not found`)
    return Promise.resolve()
  }

  let filePath = resolveRendererFile(appDir, relativePath)
  if (filePath && !existsSync(filePath)) filePath = null

  // Two URL shapes miss the app that owns the file:
  //   · /<other-route>/assets/index-*.js — a sub-page module of a route the
  //     requested app does not own; retry every app with the route segment
  //     stripped so they get their real MIME type instead of the SPA HTML
  //     (web-server parity);
  //   · /assets/index-*.js — every renderer's index.html references its bundle
  //     relatively, and from /<app> the browser resolves that to the site root,
  //     so the URL no longer says which app it came from. Content-hashed names
  //     make "first app that has this file" the right answer.
  // Neither fallback may hand back SPA HTML for a real asset: the browser
  // refuses a module served as text/html.
  if (!filePath) {
    const stripped = relativePath.replace(/^[^/]+\//, '')
    const candidates = stripped && stripped !== relativePath ? [stripped, relativePath] : [relativePath]
    for (const candidateRelative of candidates) {
      for (const candidateApp of ctx.apps) {
        const candidateDir = ctx.assets.resolveAppDir(candidateApp)
        const candidate = candidateDir ? resolveRendererFile(candidateDir, candidateRelative) : null
        if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
          filePath = candidate
          break
        }
      }
      if (filePath) break
    }
  }

  if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath)
    const isHtml = ext.toLowerCase() === '.html'
    if (isHtml) {
      const html = readFileSync(filePath, 'utf-8')
      const injectedSession = url.searchParams.get('session')
      const tags =
        (ctx.token
          ? `\n<meta name="genoffice-token" content="${ctx.token.replace(/"/g, '&quot;')}">`
          : '') +
        (injectedSession ? `\n<meta name="genoffice-session" content="${injectedSession}">` : '')
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] ?? 'text/html; charset=utf-8',
        // Token-injected HTML is a live-credential page: never cacheable.
        'Cache-Control': ctx.token ? 'no-store' : 'no-cache',
        ...corsHeader(),
      })
      response.end(html.replace(/<\/head>/i, (match) => `${tags}${match}`))
      return Promise.resolve()
    }
    return serveStaticFile({
      request,
      response,
      filePath,
      contentType: MIME_TYPES[ext] ?? 'application/octet-stream',
    })
  }

  // A resolvable-but-missing static asset must 404, never fall through to the
  // SPA HTML (browser refuses JS served as text/html).
  const requestedExt = extname(relativePath).toLowerCase()
  if (requestedExt && requestedExt !== '.html' && requestedExt in MIME_TYPES) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(`Not found: ${url.pathname}`)
    return Promise.resolve()
  }

  const indexPath = join(appDir, 'index.html')
  if (!existsSync(indexPath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end(`No renderer bundle found for '${appName}'`)
    return Promise.resolve()
  }
  const html = readFileSync(indexPath, 'utf-8')
  const tags = ctx.token ? `\n<meta name="genoffice-token" content="${ctx.token.replace(/"/g, '&quot;')}">` : ''
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...corsHeader(),
  })
  response.end(html.replace(/<\/head>/i, (match) => `${tags}${match}`))
  return Promise.resolve()
}

function resolveRendererFile(appDir: string, relativePath: string): string | null {
  const candidate = resolve(appDir, relativePath)
  if (candidate !== appDir && !candidate.startsWith(appDir + sep)) return null
  return candidate
}

// ----- binding modes ---------------------------------------------------------

export interface StagedDocument {
  /** Absolute path the workspace staged the bytes at (also the value passed to `?open=`). */
  path: string
  /** Display name the renderer shows. */
  name: string
  /** Page URL that opens this document in the sandboxed renderer. */
  url: string
}

export interface UiHostHandle {
  /** http://127.0.0.1:<port>/ — renderer pages are at /docs, /sheets, … */
  url: string
  port: number
  token: string | null
  context: UiHostContext
  /**
   * Stage bytes into the host workspace and return the renderer page URL that
   * opens them (`/docs?open=<path>`). The docs renderer's `consume-pending-open`
   * reads the `open` query param, so no host-side "pending" state is needed.
   */
  open(app: UiApp, bytes: Uint8Array, options?: { name?: string }): StagedDocument
  /** Read a workspace path back as bytes (e.g. a document the renderer just saved). */
  readFile(filePath: string): Uint8Array
  close(): Promise<void>
}

export interface StartUiHostOptions extends CreateHostContextOptions {
  /** Bind address, default 127.0.0.1. */
  host?: string
  /** Explicit port; default ephemeral (0). */
  port?: number
}

export async function startUiHost(options: StartUiHostOptions = {}): Promise<UiHostHandle> {
  const host = options.host ?? '127.0.0.1'
  const context = createHostContext(options)
  const server = createServer((request, response) => {
    void handleUiRequest(request, response, context).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' })
      }
      response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'internal host error' } }))
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, host, () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback host failed to bind a TCP port')
  const url = `http://${host}:${address.port}`
  return {
    url,
    port: address.port,
    token: context.token,
    context,
    open(app, bytes, options = {}) {
      const name = options.name ?? `${app}-document`
      const path = context.workspace.stageBytes(name, bytes)
      return {
        path,
        name,
        url: `${url}/${app}?open=${encodeURIComponent(path)}`,
      }
    },
    readFile(filePath) {
      const resolved = context.workspace.resolvePath(filePath)
      if (!resolved) throw new OfficeError('OFFICE_BAD_INPUT', `path is outside the office-ai workspace: ${filePath}`)
      return context.workspace.readBytes(resolved)
    },
    close: () =>
      new Promise<void>((resolvePromise) => {
        context.sse.close()
        server.close(() => {
          context.workspace.dispose()
          resolvePromise()
        })
      }),
  }
}

export interface AttachUiOptions extends CreateHostContextOptions {
  /** Path prefix on the existing server, default '/office-ai'. */
  basePath: string
}

/**
 * Attach the UI host to an existing http.Server. The original request
 * listener is preserved: requests under basePath go to office-ai, everything
 * else falls through. Returns the context (register handlers with
 * `context.registry.registerHandle(...)`) and a detach() to undo the wrap.
 */
export function attachUi(
  server: Server,
  options: AttachUiOptions,
): { context: UiHostContext; detach(): void } {
  const context = createHostContext({ ...options, basePath: options.basePath })
  const existing = server.listeners('request') as Array<
    (request: IncomingMessage, response: ServerResponse) => void
  >
  server.removeAllListeners('request')
  const ours = (request: IncomingMessage, response: ServerResponse): void => {
    void handleUiRequest(request, response, context).then((result) => {
      if (result.handled) return
      for (const listener of existing) listener(request, response)
    })
  }
  server.on('request', ours)
  return {
    context,
    detach: () => {
      server.removeListener('request', ours)
      for (const listener of existing) server.on('request', listener)
    },
  }
}

// ----- small helpers ---------------------------------------------------------

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '')
  if (!trimmed || trimmed === '') return '/'
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function setCors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-ipc-session')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function corsHeader(): Record<string, string> {
  return { 'Access-Control-Allow-Origin': '*' }
}

function isAuthorized(url: URL, headers: IncomingMessage['headers'], token: string): boolean {
  const bearer = headers.authorization
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && bearer.slice(7) === token) return true
  if (url.searchParams.get('token') === token) return true
  const headerToken = headers['x-genoffice-token']
  if (typeof headerToken === 'string' && headerToken === token) return true
  return false
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

export { ipcErrorStatus }
export const OFFICE_UI_DEFAULT_APPS: readonly UiApp[] = ['docs', 'sheets', 'slides', 'pdf']
export type { Registry } from './registry'
export type { UiApp } from './assets'