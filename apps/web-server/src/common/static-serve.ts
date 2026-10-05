/**
 * Static file serving with HTTP caching and compression negotiation.
 *
 * Replaces the bare `writeHead(Content-Type)` + `createReadStream().pipe()`
 * pairs that used to serve every static asset: the embed path re-downloaded
 * the full multi-MB bundle on every visit because nothing here negotiated
 * `Accept-Encoding`, emitted cache validators, or let browsers reuse cached
 * copies.
 *
 * Behaviour:
 *  - Content-hash-named files (Vite emits `index-<hash>.js`, fonts as
 *    `Name-<hash>.woff2`) get `Cache-Control: immutable`; everything else
 *    (SDK bundle, HTML) gets a short `max-age` so revalidation is cheap.
 *  - Every response carries a weak ETag (`size-mtime`, the nginx convention)
 *    and honours `If-None-Match` with a body-less 304.
 *  - `Accept-Encoding` is negotiated: gzip is produced at runtime and memoised
 *    in a bounded LRU keyed by path+mtime, brotli is served only from a
 *    precompressed `<file>.br` sidecar (runtime brotli on multi-MB JS costs
 *    more CPU than it saves on a warm server). WOFF2, raster images, video and
 *    archive/office binary types are never compressed — they are already
 *    compressed formats.
 *  - The ETag is encoding-scoped (`-gz` / `-br` suffix, nginx convention) so a
 *    cached gzip variant can never validate against a raw response.
 *
 * Callers keep their existing auth semantics; this helper is pure transport.
 */
import { createReadStream, existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { gzip as gzipCb } from 'node:zlib'
import { promisify } from 'node:util'
import { basename } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const gzip = promisify(gzipCb)

/** Compressed-response LRU budget. Docs+SDK static assets are ~13MB raw, so
 *  one gzipped copy of each fits well inside this; the cap only guards against
 *  pathological trees. */
const CACHE_MAX_BYTES = 64 * 1024 * 1024

/** MIME types worth compressing. Everything else (woff2, png, mp4, zip,
 *  docx… PDF) is already a compressed binary format — re-compressing burns
 *  CPU for ~0% gain and delays first byte. */
const COMPRESSIBLE_TYPE = /^(?:text\/|application\/(?:javascript|json|xml|manifest\+json|xhtml\+xml)|image\/svg\+xml|font\/(?:ttf|otf|woff))$/

/** Vite content-hashed asset basenames: `index-DE4hpCm2.js`,
 *  `NotoSansCJKsc-Regular-subset-DhHdCp9T.woff2`. Only these may be immutable;
 *  unhashed names change content in place. */
const HASHED_NAME = /-[A-Za-z0-9_-]{8,}\.\w+$/

interface LruEntry {
  body: Buffer
  bytes: number
}

const compressedCache = new Map<string, LruEntry>()
let compressedCacheBytes = 0
/** In-flight compressions keyed like the cache, so concurrent cold requests
 *  share one compression instead of running N. */
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
  /** Absolute path inside the caller's containment-checked root. */
  filePath: string
  contentType: string
  /** Overrides the hashed-name cache heuristic (e.g. `no-cache` for HTML). */
  cacheControl?: string
  /** Merged into every response (SDK route's `Access-Control-Allow-Origin`). */
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
    sendJsonError(response)
    return
  }

  const cacheControl =
    options.cacheControl ??
    (HASHED_NAME.test(basename(filePath))
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300')

  // Per-encoding ETag (nginx `-gzip` convention): a cached compressed variant
  // must never validate an uncompressed response or vice versa.
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
    // Compression choice depends on this header; caches must key on it even
    // for uncompressed responses (the 304 path especially).
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
  let bodyPromise: Promise<Buffer> | undefined = cached
    ? Promise.resolve(cached.body)
    : inflight.get(cacheKey)
  if (!bodyPromise) {
    // Synchronous check-then-set above: no await between, so concurrent cold
    // requests share one compression.
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
    sendJsonError(response)
    return
  }
  response.writeHead(200, { ...baseHeaders, 'Content-Encoding': negotiated, 'Content-Length': body.length })
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(body)
}

function sendJsonError(response: ServerResponse): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(500, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'static file unreadable' } }))
}
