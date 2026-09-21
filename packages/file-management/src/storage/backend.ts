/**
 * Storage backend abstraction for the GenOffice document pipeline.
 *
 * Before this module, every handler reached directly into `writeFileSync` /
 * `readFileSync` and pinned itself to the local filesystem. That worked until
 * the same handlers had to also accept bytes from the browser (the `web:save-
 * file` flow) and ship them to a remote bucket. There is no good way to make
 * `writeFileSync` upload to S3.
 *
 * The contract below is intentionally narrow: bytes in, bytes out, plus enough
 * metadata for the renderer to render a row and the recents/index store to
 * rebuild itself after a restart. Anything that doesn't fit (versioning,
 * signed-URL refresh, multipart, …) lives on the backend, not on the
 * interface, so the rest of the pipeline never grows a special case.
 *
 * Implementations:
 *   - {@link LocalStorageBackend} — the default; writes to a managed directory
 *     using the same atomic-write kernel the document stores already use.
 *   - {@link S3StorageBackend}    — AWS S3 via the official SDK; also serves
 *     rustfs and MinIO (both are wire-compatible with S3). The factory tags
 *     each instance with its `id` so logs/metrics can tell the three apart.
 *
 * Picking a backend: {@link createStorageBackend} reads `GENOFFICE_STORAGE`
 * (or the explicit `config` argument) and returns the matching instance.
 */

export interface PutOptions {
  /** Best-effort hint; the backend may ignore it (e.g. S3 forwards it as a
   *  ContentType header; local stores it as a sibling `.meta.json`). */
  contentType?: string
  /** Caller-supplied key/value metadata; persisted alongside the bytes so a
   *  subsequent `head()` can echo it back. */
  meta?: Record<string, string>
}

export interface HeadResult {
  exists: boolean
  size: number
  contentType?: string
  /** UTC ISO string, or undefined when the backend doesn't track it. */
  modifiedAt?: string
  meta?: Record<string, string>
}

export interface ListEntry {
  key: string
  size: number
  modifiedAt?: string
}

export interface SignedUrlOptions {
  /** Seconds until the URL expires. Backends that don't sign URLs may
   *  resolve with a permanent URL and ignore this. */
  expiresInSeconds?: number
}

/** The whole surface the document pipeline relies on. */
export interface StorageBackend {
  readonly id: 'local' | 'minio' | 's3' | 'rustfs'
  /** Render the bytes for `key` into a Buffer. Throws when missing. */
  get(key: string): Promise<Uint8Array>
  /** Returns `{ exists: false }` rather than throwing for a missing key. */
  head(key: string): Promise<HeadResult>
  /** Convenience: true iff `head()` reports the key exists. */
  exists(key: string): Promise<boolean>
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<{ key: string; size: number }>
  delete(key: string): Promise<void>
  list(prefix?: string): Promise<ListEntry[]>
  /** Returns either a short-lived signed URL or a stable handle. Backends
   *  that don't sign may return the key itself; callers must treat it as
   *  opaque and not assume it is resolvable outside the backend. */
  getSignedUrl(key: string, opts?: SignedUrlOptions): Promise<string>
}

/** Thrown by backends when the caller asks for a key that does not exist
 *  and the operation requires it (i.e. `get`, but not `head`). Backends MUST
 *  throw this rather than a generic Error so the web-server can map it to a
 *  404. */
export class StorageNotFoundError extends Error {
  constructor(public readonly backend: string, public readonly key: string) {
    super(`[${backend}] key not found: ${key}`)
    this.name = 'StorageNotFoundError'
  }
}

export interface StorageBackendConfig {
  /** 'local' | 'minio' | 's3' | 'rustfs'. Defaults to 'local'. */
  backend?: 'local' | 'minio' | 's3' | 'rustfs'
  /** Root directory for the local backend (mandatory). */
  filesDir: string
  /** Public base URL the renderer can use to address local files; defaults
   *  to a `/files/<key>` shape. Used by `getSignedUrl`. */
  publicBaseUrl?: string
  /** MinIO-specific configuration. MinIO is wire-compatible with S3, so the
   *  shape mirrors `s3`; the factory supplies sensible defaults for a
   *  standalone MinIO server (endpoint `http://127.0.0.1:9000`, path-style,
   *  bucket `genoffice`, region `us-east-1`) when these are left unset. */
  minio?: {
    endpoint?: string
    region?: string
    bucket?: string
    accessKeyId?: string
    secretAccessKey?: string
    forcePathStyle?: boolean
    timeoutMs?: number
  }
  /** S3-specific configuration. Ignored unless backend === 's3'. */
  s3?: {
    endpoint?: string
    region?: string
    bucket?: string
    accessKeyId?: string
    secretAccessKey?: string
    forcePathStyle?: boolean
    timeoutMs?: number
  }
  /** RustFS-specific configuration. rustfs is wire-compatible with S3 so the
   *  shape mirrors `s3`; the factory supplies a default endpoint of
   *  `http://127.0.0.1:9000` and `forcePathStyle: true` when this is unset. */
  rustfs?: {
    endpoint?: string
    region?: string
    bucket?: string
    accessKeyId?: string
    secretAccessKey?: string
    forcePathStyle?: boolean
    timeoutMs?: number
  }
}
