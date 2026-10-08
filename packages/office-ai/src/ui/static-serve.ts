/**
 * Static file serving with caching + compression negotiation — ported from
 * apps/web-server/src/common/static-serve.ts (loopback UI host serves the
 * same Vite-built renderer assets, so the behavior contract carries over).
 */
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { gzip as gzipCb } from 'node:zlib'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const gzip = promisify(gzipCb)

const CACHE_MAX_BYTES = 64 * 1024 * 1024

const COMPRESSIBLE_TYPE =
  /^(?:text\/[a-z0-9.+-]+|application\/(?:javascript|json|xml|manifest\+json|xhtml\+xml)|image\/svg\+xml|font\/(?:ttf|otf|woff))$/

const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.\w+$/

interface LruEntry {
  body: Buffer
  bytes: number
}

const compressedCache = new Map<string, LruEntry>()
let compressedCacheBytes = 0
const inflight = new Map<string, Promise<Buffer>>()

function rememberCompressed(key: string, body: Buffer): void {
  compressedCache.set(key, { body, bytes: body.length })
  compressedCacheBytes += body.length
  while (compressedCacheBytes > CACHE_MAX_BYTES) {
    const oldest = compressedCache.keys().next().value
    if (oldest === undefined) break
    compressedCacheBytes -= compressedCache.get(oldest)!.bytes
    compressedCache.delete(oldest)
  }
}

function acceptsEncoding(header: string | undefined, token: 'gzip' | 'br'): boolean {
  if (!header) return false
  for (const part of header.split(',')) {
    const [name, ...params] = part.trim().split(';')
    if (name?.trim() === token || (name?.trim() === '*' && token === 'gzip')) {
      const q = params.find((p) => p.trim().startsWith('q='))
      if (!q || Number.parseFloat(q.split('=')[1] ?? '1') > 0) return true
    }
  }
  return false
}

export interface StaticServeOptions {
  request: IncomingMessage
  response: ServerResponse
  filePath: string
  contentType: string
  cacheControl?: string
  extraHeaders?: Record<string, string>
}

export async function serveStaticFile(options: StaticServeOptions): Promise<void> {
  const { request, response, filePath, contentType } = options

  let size: number
  let mtimeMs: number
  try {
    const stats = await stat(filePath)
    if (!stats.isFile()) throw new Error('not a file')
    size = stats.size
    mtimeMs = stats.mtimeMs
  } catch {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'static file unreadable' } }))
    return
  }

  const cacheControl =
    options.cacheControl ??
    (HASHED_NAME.test(basename(filePath))
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300')

  const negotiated =
    COMPRESSIBLE_TYPE.test(contentType) && request.method !== 'HEAD' && size > 1024
      ? acceptsEncoding(request.headers['accept-encoding'], 'br') && existsSync(`${filePath}.br`)
        ? ('br' as const)
        : acceptsEncoding(request.headers['accept-encoding'], 'gzip')
          ? ('gzip' as const)
          : null
      : null
  const etag = `W/"${size}-${Math.floor(mtimeMs)}${negotiated === 'br' ? '-br' : negotiated === 'gzip' ? '-gz' : ''}"`

  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    Vary: 'Accept-Encoding',
    ETag: etag,
    'Cache-Control': cacheControl,
    ...options.extraHeaders,
  }

  if ((request.headers['if-none-match'] ?? '').includes(etag)) {
    response.writeHead(304, baseHeaders)
    response.end()
    return
  }

  if (!negotiated) {
    response.writeHead(200, baseHeaders)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(filePath).pipe(response)
    return
  }

  const cacheKey = `${filePath}|${mtimeMs}|${negotiated}`
  const cached = compressedCache.get(cacheKey)
  let bodyPromise: Promise<Buffer> | undefined = cached ? Promise.resolve(cached.body) : inflight.get(cacheKey)
  if (!bodyPromise) {
    bodyPromise =
      negotiated === 'br' ? readFile(`${filePath}.br`) : readFile(filePath).then((raw) => gzip(raw, { level: 6 }))
    inflight.set(cacheKey, bodyPromise)
    void bodyPromise
      .then((body) => {
        rememberCompressed(cacheKey, body)
      })
      .catch(() => {})
      .finally(() => {
        inflight.delete(cacheKey)
      })
  }

  let body: Buffer
  try {
    body = await bodyPromise
  } catch {
    response.writeHead(500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'static file unreadable' } }))
    return
  }
  response.writeHead(200, { ...baseHeaders, 'Content-Encoding': negotiated, 'Content-Length': body.length })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(body)
}