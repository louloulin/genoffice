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
 *   - {@link MimoStorageBackend}  — HTTP remote storage; talks to any
 *     PUT/GET/DELETE endpoint (the mimo2codex project exposes a small one for
 *     its Codex Pets feature, but the implementation is endpoint-agnostic so
 *     it also doubles as a generic HTTP file-store backend).
 *   - {@link S3StorageBackend}    — kept as a stub for Phase 4. The shape is
 *     what we want; the AWS SDK wiring is left to whoever owns Phase 4 so this
 *     package doesn't grow a 30-MiB dependency tree today.
 *
 * Picking a backend: {@link createStorageBackend} reads `GENOFFICE_STORAGE`
 * (or the explicit `config` argument) and returns the matching instance.
 */

export interface PutOptions {
  /** Best-effort hint; the backend may ignore it (e.g. mimo forwards as a
   *  Content-Type header; local stores it as a sibling `.meta.json`). */
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
  readonly id: 'local' | 'mimo' | 's3' | 'rustfs'
  /** Render the bytes for `key` into a Buffer. Throws when missing. */
  get(key: string): Promise<Uint8Array>
  /** Returns `{ exists: false }` rather than throwing for a missing key. */
  head(key: string): Promise<HeadResult>
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
  /** 'local' | 'mimo' | 's3' | 'rustfs'. Defaults to 'local'. */
  backend?: 'local' | 'mimo' | 's3' | 'rustfs'
  /** Root directory for the local backend (mandatory). */
  filesDir: string
  /** Public base URL the renderer can use to address local files; defaults
   *  to a `/files/<key>` shape. Used by `getSignedUrl`. */
  publicBaseUrl?: string
  /** Mimo-specific configuration. Ignored by other backends. */
  mimo?: {
    endpoint: string
    apiKey?: string
    bucket?: string
    /** Per-request timeout in ms; defaults to 30_000. */
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
