/**
 * Filesystem-backed {@link StorageBackend}. The default for every install.
 *
 * Writes are atomic: a temp file in the same directory gets `rename`'d over
 * the final name, which guarantees that an interrupted `put` either leaves the
 * previous bytes intact or the new bytes, never a mix. The Windows-EPERM
 * retry that `atomicWriteFile` already does is inherited.
 *
 * `getSignedUrl` resolves to a `<publicBaseUrl>/<key>` URL. Callers that need
 * an expiring URL wrap the call in their own layer; the backend itself never
 * signs because the bytes are already addressable from the local host.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { atomicWriteFile } from '../atomic'
import {
  StorageNotFoundError,
  type HeadResult,
  type ListEntry,
  type PutOptions,
  type StorageBackend,
  type StorageBackendConfig,
} from './backend'

/** Where to record the optional `contentType` and `meta` payload. Sibling of
 *  the file so a failed rename doesn't strand the metadata next to fresh
 *  bytes. */
const META_SUFFIX = '.meta.json'

export class LocalStorageBackend implements StorageBackend {
  readonly id = 'local' as const
  private readonly filesDir: string
  private readonly publicBaseUrl: string

  constructor(config: StorageBackendConfig) {
    if (!config.filesDir) throw new Error('LocalStorageBackend: filesDir is required')
    this.filesDir = config.filesDir
    this.publicBaseUrl = (config.publicBaseUrl ?? '').replace(/\/$/, '')
    mkdirSync(this.filesDir, { recursive: true })
  }

  private pathFor(key: string): string {
    /* Refuse absolute paths and `..` segments: a key is supposed to be an
     * opaque identifier (e.g. "<counter>-<ts>-<rand>-name.docx"), and
     * letting the caller escape `filesDir` defeats the managed-path guard
     * the web-server already enforces. */
    if (key.includes('/') || key.includes('\\') || key.startsWith('.')) {
      throw new Error(`LocalStorageBackend: refusing unsafe key "${key}"`)
    }
    return join(this.filesDir, key)
  }

  private metaPathFor(key: string): string {
    return this.pathFor(key) + META_SUFFIX
  }

  async get(key: string): Promise<Uint8Array> {
    const path = this.pathFor(key)
    if (!existsSync(path)) throw new StorageNotFoundError(this.id, key)
    return new Uint8Array(readFileSync(path))
  }

  async head(key: string): Promise<HeadResult> {
    const path = this.pathFor(key)
    if (!existsSync(path)) return { exists: false, size: 0 }
    const stats = statSync(path)
    const meta = this.readMeta(key)
    return {
      exists: true,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      ...(meta ?? {}),
    }
  }

  async put(
    key: string,
    bytes: Uint8Array,
    opts: PutOptions = {},
  ): Promise<{ key: string; size: number }> {
    const path = this.pathFor(key)
    mkdirSync(dirname(path), { recursive: true })
    const buffer = Buffer.from(bytes)
    atomicWriteFile(path, buffer)
    if (opts.contentType || opts.meta) {
      const meta = {
        contentType: opts.contentType,
        meta: opts.meta ?? {},
        storedAt: new Date().toISOString(),
      }
      atomicWriteFile(this.metaPathFor(key), Buffer.from(JSON.stringify(meta), 'utf-8'))
    }
    return { key, size: buffer.byteLength }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key)
    if (existsSync(path)) unlinkSync(path)
    const metaPath = this.metaPathFor(key)
    if (existsSync(metaPath)) unlinkSync(metaPath)
  }

  async list(prefix = ''): Promise<ListEntry[]> {
    if (!existsSync(this.filesDir)) return []
    const entries: ListEntry[] = []
    for (const name of readdirSync(this.filesDir)) {
      if (name.endsWith(META_SUFFIX)) continue
      if (prefix && !name.startsWith(prefix)) continue
      const path = join(this.filesDir, name)
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        entries.push({ key: name, size: stats.size, modifiedAt: stats.mtime.toISOString() })
      } catch {
        /* a vanished file between readdir and stat is fine; skip */
      }
    }
    return entries
  }

  async getSignedUrl(key: string): Promise<string> {
    /* Local files are served from the host's own port — no signing needed.
     * The base URL is whatever the caller configured (e.g.
     * `http://127.0.0.1:18081/files/`); empty means the renderer must fall
     * back to a different transport (the web-server does this via the
     * `files:read` channel). */
    return this.publicBaseUrl ? `${this.publicBaseUrl}/${key}` : key
  }

  private readMeta(key: string): { contentType?: string; meta?: Record<string, string> } | null {
    const metaPath = this.metaPathFor(key)
    if (!existsSync(metaPath)) return null
    try {
      const raw = JSON.parse(readFileSync(metaPath, 'utf-8'))
      return { contentType: raw.contentType, meta: raw.meta }
    } catch {
      /* corrupt meta isn't fatal — fall back to fs-only metadata. */
      return null
    }
  }
}

/* Exposed for tests so they don't have to fish through the file system. */
export const __TESTING__ = { META_SUFFIX }
