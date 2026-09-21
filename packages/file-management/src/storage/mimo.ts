/**
 * HTTP-backed {@link StorageBackend} that talks to any PUT/GET/DELETE
 * endpoint — named "mimo" because the mimo2codex project exposes a small
 * one for its Codex Pets feature, but the implementation makes no
 * assumption about the *server* beyond what the contract below spells out,
 * so it doubles as a generic remote file-store backend.
 *
 * Wire protocol (all requests go to `<endpoint>` with optional `?bucket=…`):
 *   PUT    /<key>            body = raw bytes, headers Content-Type, X-Genoffice-Meta
 *   GET    /<key>            → 200 raw bytes, or 404
 *   HEAD   /<key>            → 200 + Content-Length / X-Genoffice-Meta, or 404
 *   DELETE /<key>            → 204 (idempotent — 404 still resolves)
 *   GET    /?list=1          → 200 { items: [{key,size,modifiedAt}] }
 *   GET    /<key>?signed=1&expires=<sec> → 200 { url }
 *
 * The endpoint only has to implement those five verbs. Anything richer
 * (multipart upload, range reads, ACLs) is out of scope.
 */
import {
  StorageNotFoundError,
  type HeadResult,
  type ListEntry,
  type PutOptions,
  type SignedUrlOptions,
  type StorageBackend,
  type StorageBackendConfig,
} from './backend'

interface MimoConfig {
  endpoint: string
  apiKey?: string
  bucket?: string
  timeoutMs: number
}

function safeKey(key: string): string {
  if (!key || key.includes('\0')) {
    throw new Error(`MimoStorageBackend: refusing unsafe key "${key}"`)
  }
  return key
}

function joinUrl(endpoint: string, key: string, query?: Record<string, string>): string {
  const base = endpoint.replace(/\/$/, '')
  const sep = key.includes('?') ? '&' : '?'
  const qs = query ? Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&') : ''
  return `${base}/${key}${qs ? sep + qs : ''}`
}

function joinListUrl(endpoint: string, bucket: string | undefined, prefix: string | undefined): string {
  const base = endpoint.replace(/\/$/, '')
  const params = new URLSearchParams()
  params.set('list', '1')
  if (bucket) params.set('bucket', bucket)
  if (prefix) params.set('prefix', prefix)
  return `${base}/?${params.toString()}`
}

export class MimoStorageBackend implements StorageBackend {
  readonly id = 'mimo' as const
  private readonly cfg: MimoConfig

  constructor(config: StorageBackendConfig) {
    const m = config.mimo
    if (!m?.endpoint) {
      throw new Error('MimoStorageBackend: mimo.endpoint is required')
    }
    this.cfg = {
      endpoint: m.endpoint,
      apiKey: m.apiKey,
      bucket: m.bucket,
      timeoutMs: m.timeoutMs ?? 30_000,
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (this.cfg.apiKey) h['Authorization'] = `Bearer ${this.cfg.apiKey}`
    return h
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    /* Node ≥18 has a built-in AbortController and `fetch`. The web-server
     * already targets Node 22; this is here so the package compiles
     * standalone too. */
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs)
    try {
      return await fetch(url, { ...init, signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async get(key: string): Promise<Uint8Array> {
    safeKey(key)
    const url = joinUrl(this.cfg.endpoint, key, this.cfg.bucket ? { bucket: this.cfg.bucket } : undefined)
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: this.headers() })
    if (res.status === 404) throw new StorageNotFoundError(this.id, key)
    if (!res.ok) throw new Error(`[mimo] GET ${key} failed: ${res.status} ${res.statusText}`)
    const buf = await res.arrayBuffer()
    return new Uint8Array(buf)
  }

  async head(key: string): Promise<HeadResult> {
    safeKey(key)
    const url = joinUrl(this.cfg.endpoint, key, this.cfg.bucket ? { bucket: this.cfg.bucket } : undefined)
    const res = await this.fetchWithTimeout(url, { method: 'HEAD', headers: this.headers() })
    if (res.status === 404) return { exists: false, size: 0 }
    if (!res.ok) throw new Error(`[mimo] HEAD ${key} failed: ${res.status} ${res.statusText}`)
    const size = Number(res.headers.get('content-length') ?? '0')
    const contentType = res.headers.get('content-type') ?? undefined
    const metaHeader = res.headers.get('x-genoffice-meta')
    let meta: Record<string, string> | undefined
    if (metaHeader) {
      try {
        meta = JSON.parse(Buffer.from(metaHeader, 'base64').toString('utf-8'))
      } catch {
        /* server returned junk — ignore and return just content-type/size */
      }
    }
    return { exists: true, size, contentType, meta }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    opts: PutOptions = {},
  ): Promise<{ key: string; size: number }> {
    safeKey(key)
    const url = joinUrl(this.cfg.endpoint, key, this.cfg.bucket ? { bucket: this.cfg.bucket } : undefined)
    const headers: Record<string, string> = {}
    if (opts.contentType) headers['Content-Type'] = opts.contentType
    if (opts.meta) headers['X-Genoffice-Meta'] = Buffer.from(JSON.stringify(opts.meta), 'utf-8').toString('base64')
    const res = await this.fetchWithTimeout(url, {
      method: 'PUT',
      headers: this.headers(headers),
      body: bytes as BodyInit,
    })
    if (!res.ok) throw new Error(`[mimo] PUT ${key} failed: ${res.status} ${res.statusText}`)
    return { key, size: bytes.byteLength }
  }

  async delete(key: string): Promise<void> {
    safeKey(key)
    const url = joinUrl(this.cfg.endpoint, key, this.cfg.bucket ? { bucket: this.cfg.bucket } : undefined)
    /* The contract says 404 is fine; we still surface other failures because
     * a 500 on DELETE is usually a server-side bug worth surfacing. */
    const res = await this.fetchWithTimeout(url, { method: 'DELETE', headers: this.headers() })
    if (res.status !== 204 && res.status !== 404 && !res.ok) {
      throw new Error(`[mimo] DELETE ${key} failed: ${res.status} ${res.statusText}`)
    }
  }

  async list(prefix = ''): Promise<ListEntry[]> {
    const url = joinListUrl(this.cfg.endpoint, this.cfg.bucket, prefix || undefined)
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: this.headers() })
    if (!res.ok) throw new Error(`[mimo] LIST failed: ${res.status} ${res.statusText}`)
    const body = (await res.json()) as { items?: Array<{ key?: unknown; size?: unknown; modifiedAt?: unknown }> }
    if (!body || !Array.isArray(body.items)) return []
    return body.items
      .filter((it): it is { key: string; size: number; modifiedAt?: string } =>
        typeof it?.key === 'string' && typeof it?.size === 'number',
      )
      .map((it) => ({ key: it.key, size: it.size, modifiedAt: typeof it.modifiedAt === 'string' ? it.modifiedAt : undefined }))
  }

  async getSignedUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    safeKey(key)
    const expiresIn = opts.expiresInSeconds ?? 3600
    const q: Record<string, string> = { signed: '1', expires: String(expiresIn) }
    if (this.cfg.bucket) q.bucket = this.cfg.bucket
    const url = joinUrl(this.cfg.endpoint, key, q)
    const res = await this.fetchWithTimeout(url, { method: 'GET', headers: this.headers() })
    if (res.status === 404) throw new StorageNotFoundError(this.id, key)
    if (!res.ok) throw new Error(`[mimo] signed-url for ${key} failed: ${res.status} ${res.statusText}`)
    const body = (await res.json()) as { url?: unknown }
    if (typeof body.url !== 'string' || !body.url) {
      throw new Error(`[mimo] signed-url response missing "url"`)
    }
    return body.url
  }
}
