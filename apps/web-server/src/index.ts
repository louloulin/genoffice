/**
 * GenOffice Web Server - HTTP entry point.
 *
 * After the Phase 1.1 split, this file only wires the HTTP transport
 * (HTTP+SSE), delegates IPC dispatch to capability modules, and serves
 * the static SPA bundles from apps/<name>/out/renderer.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { allChannels, decodeTransportValue, encodeTransportValue, getHandler, handlerCount } from './common/registry.js'
import { APPS, HOST, MIME_TYPES, PORT, STATIC_ROOT } from './common/store.js'
import { registerAiHandlers } from './ai/index.js'
import { registerAnydocHandlers } from './anydoc/index.js'
import { registerAppHandlers } from './app/index.js'
import { registerCollabHandlers, snapshotCollabSessions } from './collab/index.js'
import { registerDocsHandlers } from './docs/index.js'
import { registerEnterpriseHandlers } from './enterprise/index.js'
import { registerFilesHandlers } from './files/index.js'
import { registerMarkdownHandlers } from './markdown/index.js'
import { registerPdfHandlers } from './pdf/index.js'
import { registerProjectHandlers } from './projects/index.js'
import { registerSheetsHandlers } from './sheets/index.js'
import { registerShellHandlers } from './shell/index.js'
import { registerSlidesHandlers } from './slides/index.js'
import { registerWebHandlers } from './web/index.js'

import { handleAgentStream } from './server/agent-loop.js'
import { readBody, sendJson } from './server/http.js'
import { PENDING_FRAMES, SSE_HEARTBEAT_MS, pushSseEvent, sessionConnections } from './server/sse.js'

// ----------------------------------------------------------------------------
// Bootstrap: register every capability's IPC handlers before binding the port.
// ----------------------------------------------------------------------------

registerAppHandlers()
registerProjectHandlers()
registerFilesHandlers()
registerDocsHandlers()
registerSheetsHandlers()
registerSlidesHandlers()
registerMarkdownHandlers()
registerAnydocHandlers()
registerPdfHandlers()
registerShellHandlers()
registerWebHandlers()
registerAiHandlers()
registerCollabHandlers()
registerEnterpriseHandlers()

// ----------------------------------------------------------------------------
// HTTP server
// ----------------------------------------------------------------------------

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', `http://${request.headers.host}`)

  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-IPC-Session')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  // Health
  if (url.pathname === '/health' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        status: 'ok',
        version: '0.8.0',
        mode: 'web-server',
        implementedChannels: handlerCount(),
        features: ['ai', 'collab', 'files', 'projects'],
      }),
    )
    return
  }

  // Channel listing
  if (url.pathname === '/api/channels' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ channels: allChannels().sort() }))
    return
  }

  // Collab sessions listing
  if (url.pathname === '/api/collab/sessions' && request.method === 'GET') {
    const sessions = snapshotCollabSessions()
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ sessions }))
    return
  }

  // IPC invoke
  if (url.pathname.startsWith('/api/ipc/') && request.method === 'POST') {
    const channel = url.pathname.slice('/api/ipc/'.length)
    const session = request.headers['x-ipc-session'] as string | undefined

    try {
      const body = await readBody(request)
      const { args = [] } = JSON.parse(body || '{}')

      const decodedArgs = (args as unknown[]).map(arg => decodeTransportValue(arg))

      const handler = getHandler(channel)
      if (handler) {
        const event = {
          processId: 0,
          frameId: 0,
          sender: {
            id: -1,
            isDestroyed: () => false,
            send: (ch: string, ...a: unknown[]) => {
              const encodedArgs = a.map(arg => encodeTransportValue(arg))
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
      sendJson(response, 500, { error: { message: String((error as Error)?.message) } })
    }
    return
  }

  // SSE event stream
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

    request.on('close', () => {
      clearInterval(heartbeat)
      sessionConnections.get(session)?.delete(response)
      if (sessionConnections.get(session)?.size === 0) {
        sessionConnections.delete(session)
      }
    })
    return
  }

  // Agent Loop SSE
  if (url.pathname === '/api/ai/stream' && request.method === 'POST') {
    await handleAgentStream(request, response)
    return
  }

  // Static SPA fallback (apps/<app>/out/renderer/...)
  const appName = url.searchParams.get('app') || 'docs'
  let filePath = resolve(STATIC_ROOT, appName, 'out', 'renderer', url.pathname === '/' ? 'index.html' : url.pathname)

  if (!existsSync(filePath)) {
    filePath = resolve(STATIC_ROOT, 'docs', 'out', 'renderer', url.pathname === '/' ? 'index.html' : url.pathname)
  }

  if (existsSync(filePath) && statSync(filePath).isFile()) {
    const ext = extname(filePath)
    response.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' })
    createReadStream(filePath).pipe(response)
    return
  }

  const indexPath = resolve(STATIC_ROOT, 'docs', 'out', 'renderer', 'index.html')
  if (existsSync(indexPath)) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    createReadStream(indexPath).pipe(response)
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end('<h1>GenOffice Web Server</h1><p>Please build the apps first: npm run build:all</p>')
})

server.listen(PORT, HOST, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   GenOffice Web Server v0.8.0 (Enhanced)                ║
║                                                           ║
    URL: http://${HOST}:${PORT}
║   📁 Mode: Standalone (No Electron)                        ║
║                                                           ║
║   Apps: ${APPS.slice(0, 4).join(', ')}...                   ║
║                                                           ║
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

process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
process.on('SIGINT', () => { server.close(() => process.exit(0)) })
