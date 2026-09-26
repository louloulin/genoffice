/**
 * Generic file-management capability — REST v1 client over `/api/v1/files`.
 *
 * Scope (P0):
 *   - `list()`         GET    /api/v1/files              → list metadata
 *   - `get(id)`        GET    /api/v1/files/:id          → metadata
 *   - `create(input)`  POST   /api/v1/files              → upload bytes
 *   - `delete(id)`     DELETE /api/v1/files/:id          → remove
 *
 * Out of scope (added in W3):
 *   - versions / comments / callback / jwt / embed nonce
 *   - raw content download (use the embed editor for that; v1 REST only
 *     exposes metadata)
 *
 * Zero-deps. The default `fetch` is `globalThis.fetch`; consumers running on
 * older Node runtimes or in tests can pass a custom `fetch` via the config.
 *
 * The class is intentionally consumer-agnostic: no iframe / dataflare /
 * postMessage / session-binding concerns live here. The dataflare bridge
 * (`@genoffice/web-sdk/dataflare/host`) is one possible consumer — it uses
 * `FileClient` to mint the JWT and nonce on behalf of the iframe, but
 * nothing in this module knows that.
 */

// ── Public types ────────────────────────────────────────────────────────────

export interface FileMetadata {
  id: string
  name: string
  size: number
  mtime: number
  /** Absolute path on the web-server's host. Server-only metadata. */
  path: string
}

export interface FileListEntry {
  id: string
  name: string
  size: number
  mtime: number
  path: string
}

export interface FileCreateInput {
  /** Display name including extension. Server sanitises to `[a-zA-Z0-9._-]`. */
  name: string
  /**
   * File bytes. Accepts `Uint8Array`, `ArrayBuffer`, or a `Blob` (browsers).
   * Server caps upload at 100 MiB; empty payloads are rejected as 400.
   */
  bytes: Uint8Array | ArrayBuffer | Blob
}

export interface FileCreateResult {
  id: string
  name: string
  size: number
  /** Canonical storage path on the server. */
  path: string
}

export interface FileDeleteResult {
  ok: true
  deleted: string
}

export interface FileClientConfig {
  /**
   * Base URL of the web-server (e.g. `https://app.example.com/office-engine`).
   * Trailing slash is optional; the client normalises.
   */
  baseUrl: string
  /**
   * Bearer JWT to send as `Authorization: Bearer …`. Pass `null` to disable
   * (rely on cookies). Pass a function for last-minute rotation.
   */
  bearer?: string | null | (() => string | null | Promise<string | null>)
  /**
   * Custom fetch implementation. Defaults to `globalThis.fetch`.
   * Useful for: Node < 22 polyfills, SSR, mock servers in tests.
   */
  fetch?: typeof fetch
  /**
   * Default headers merged into every request (after auth headers).
   * Override per-call by passing `options.headers`.
   */
  defaultHeaders?: Record<string, string>
  /**
   * Default request timeout in milliseconds. `0` disables the timeout.
   * Default: 30 000. Per-call `AbortSignal` takes precedence when supplied.
   */
  timeoutMs?: number
}

export interface FileCallOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  /**
   * Per-call override for the timeout (milliseconds). `0` disables.
   * `undefined` falls back to `FileClientConfig.timeoutMs`.
   */
  timeoutMs?: number
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type FileErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'UNKNOWN'

/**
 * Standard error thrown by every FileClient method.
 *
 * The shape mirrors the web-server envelope: `{ error: { message, code, channel? } }`.
 * Network failures and timeouts map to `NETWORK` / `TIMEOUT` / `ABORTED`.
 */
export class FileError extends Error {
  readonly code: FileErrorCode
  readonly status: number
  readonly channel: string
  /** Server-supplied detail, when available. */
  readonly detail: unknown

  constructor(input: {
    code: FileErrorCode
    message: string
    status: number
    channel: string
    detail?: unknown
    cause?: unknown
  }) {
    super(input.message)
    this.name = 'FileError'
    this.code = input.code
    this.status = input.status
    this.channel = input.channel
    this.detail = input.detail
    if (input.cause !== undefined) {
      // ES2022 — Node 18+/all modern browsers support it.
      ;(this as Error & { cause?: unknown }).cause = input.cause
    }
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000
const BASE64_CHUNK = 0x8000

export class FileClient {
  readonly baseUrl: string
  #bearer: FileClientConfig['bearer']
  readonly #fetch: typeof fetch
  readonly #defaultHeaders: Record<string, string>
  readonly #defaultTimeoutMs: number

  constructor(config: FileClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('FileClient: baseUrl is required')
    }
    this.baseUrl = stripTrailingSlash(config.baseUrl)
    this.#bearer = config.bearer
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis)
    this.#defaultHeaders = { ...(config.defaultHeaders ?? {}) }
    this.#defaultTimeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    if (typeof this.#fetch !== 'function') {
      throw new TypeError('FileClient: global fetch is unavailable; pass `fetch` in the config')
    }
  }

  // ── list ────────────────────────────────────────────────────────────────

  async list(options: FileCallOptions = {}): Promise<FileListEntry[]> {
    const res = await this.#request('GET', '/api/v1/files', undefined, 'files:list', options)
    const body = (await res.json()) as { files?: unknown }
    if (!isObject(body) || !Array.isArray(body.files)) {
      throw new FileError({
        code: 'UNKNOWN',
        message: 'FileClient.list: response missing `files` array',
        status: 200,
        channel: 'files:list',
        detail: body,
      })
    }
    return body.files.filter(isFileListEntry).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      mtime: f.mtime,
      path: f.path,
    }))
  }

  // ── get (metadata) ──────────────────────────────────────────────────────

  async get(id: string, options: FileCallOptions = {}): Promise<FileMetadata> {
    assertFileId(id, 'get')
    const res = await this.#request('GET', `/api/v1/files/${encodeFileId(id)}`, undefined, 'files:get', options)
    return parseFileMetadata(await res.json(), 'files:get')
  }

  // ── create (upload) ─────────────────────────────────────────────────────

  async create(input: FileCreateInput, options: FileCallOptions = {}): Promise<FileCreateResult> {
    if (!input || typeof input !== 'object') {
      throw new FileError({
        code: 'INVALID_ARGUMENT',
        message: 'FileClient.create: input is required',
        status: 0,
        channel: 'files:create',
      })
    }
    if (typeof input.name !== 'string' || !input.name) {
      throw new FileError({
        code: 'INVALID_ARGUMENT',
        message: 'FileClient.create: input.name is required',
        status: 0,
        channel: 'files:create',
      })
    }
    const base64 = await bytesToBase64(input.bytes)
    const res = await this.#request(
      'POST',
      '/api/v1/files',
      { name: input.name, bytes: base64 },
      'files:create',
      options,
    )
    return parseFileCreate(await res.json(), 'files:create')
  }

  // ── delete ──────────────────────────────────────────────────────────────

  async delete(id: string, options: FileCallOptions = {}): Promise<FileDeleteResult> {
    assertFileId(id, 'delete')
    const res = await this.#request(
      'DELETE',
      `/api/v1/files/${encodeFileId(id)}`,
      undefined,
      'files:delete',
      options,
    )
    const body = (await res.json()) as { ok?: unknown; deleted?: unknown }
    if (!isObject(body) || body.ok !== true || typeof body.deleted !== 'string') {
      throw new FileError({
        code: 'UNKNOWN',
        message: 'FileClient.delete: response missing { ok: true, deleted }',
        status: 200,
        channel: 'files:delete',
        detail: body,
      })
    }
    return { ok: true, deleted: body.deleted }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /** Resolve a metadata record to a navigable URL on the same origin. */
  getDownloadUrl(id: string): string {
    assertFileId(id, 'getDownloadUrl')
    return `${this.baseUrl}/api/v1/files/${encodeFileId(id)}`
  }

  /**
   * Override the bearer token for subsequent calls. Pass `null` to clear.
   * Useful for rotation without rebuilding the client.
   */
  setBearer(bearer: FileClientConfig['bearer']): void {
    this.#bearer = bearer
  }

  // ── internal: HTTP plumbing ─────────────────────────────────────────────

  async #request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    channel: string,
    options: FileCallOptions,
  ): Promise<Response> {
    const url = `${this.baseUrl}${path}`
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs
    const signal = combineSignals(options.signal, timeoutMs > 0 ? timeoutSignal(timeoutMs) : null)

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.#defaultHeaders,
      ...(options.headers ?? {}),
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const bearer = await resolveBearer(this.#bearer)
    if (bearer) headers.Authorization = `Bearer ${bearer}`

    let response: Response
    try {
      const init: RequestInit = { method, headers, signal }
      if (body !== undefined) init.body = JSON.stringify(body)
      response = await this.#fetch(url, init)
    } catch (err) {
      if (isAbortError(err)) {
        throw new FileError({
          code: 'ABORTED',
          message: 'FileClient: request aborted',
          status: 0,
          channel,
          cause: err,
        })
      }
      throw new FileError({
        code: 'NETWORK',
        message: err instanceof Error ? err.message : 'network request failed',
        status: 0,
        channel,
        cause: err,
      })
    }

    if (!response.ok) {
      const errBody = await safeReadJson(response)
      const code = pickCode(errBody, response.status)
      throw new FileError({
        code,
        message: pickMessage(errBody, response, channel),
        status: response.status,
        channel,
        detail: errBody,
      })
    }
    return response
  }
}

// ── Small utility helpers (kept module-local for tree-shaking) ──────────────

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function encodeFileId(id: string): string {
  return encodeURIComponent(id)
}

function assertFileId(id: string, op: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.includes('\0')) {
    throw new FileError({
      code: 'INVALID_ARGUMENT',
      message: `FileClient.${op}: id must be a non-empty path segment`,
      status: 0,
      channel: `files:${op}`,
    })
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isFileListEntry(v: unknown): v is FileListEntry {
  if (!isObject(v)) return false
  return (
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.size === 'number' &&
    typeof v.mtime === 'number' &&
    typeof v.path === 'string'
  )
}

function parseFileMetadata(value: unknown, channel: string): FileMetadata {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.mtime !== 'number' ||
    typeof value.path !== 'string'
  ) {
    throw new FileError({
      code: 'UNKNOWN',
      message: `FileClient.${channel}: response is not a FileMetadata`,
      status: 200,
      channel,
      detail: value,
    })
  }
  return { id: value.id, name: value.name, size: value.size, mtime: value.mtime, path: value.path }
}

function parseFileCreate(value: unknown, channel: string): FileCreateResult {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    typeof value.size !== 'number' ||
    typeof value.path !== 'string'
  ) {
    throw new FileError({
      code: 'UNKNOWN',
      message: `FileClient.${channel}: response is not a FileCreateResult`,
      status: 200,
      channel,
      detail: value,
    })
  }
  return { id: value.id, name: value.name, size: value.size, path: value.path }
}

function pickCode(body: unknown, status: number): FileErrorCode {
  if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') {
    const code = body.error.code
    if (isKnownCode(code)) return code
  }
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 400) return 'INVALID_ARGUMENT'
  if (status >= 500) return 'INTERNAL'
  return 'UNKNOWN'
}

function pickMessage(body: unknown, response: Response, channel: string): string {
  if (isObject(body) && isObject(body.error) && typeof body.error.message === 'string') {
    return body.error.message
  }
  return `${channel}: HTTP ${response.status}`
}

function isKnownCode(code: string): code is FileErrorCode {
  switch (code) {
    case 'UNAUTHENTICATED':
    case 'FORBIDDEN':
    case 'NOT_FOUND':
    case 'INVALID_ARGUMENT':
    case 'PAYLOAD_TOO_LARGE':
    case 'INTERNAL':
    case 'NETWORK':
    case 'TIMEOUT':
    case 'ABORTED':
    case 'UNKNOWN':
      return true
    default:
      return false
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

async function resolveBearer(
  bearer: FileClientConfig['bearer'],
): Promise<string | null> {
  if (bearer === undefined || bearer === null) return null
  if (typeof bearer === 'string') return bearer
  const value = await bearer()
  return value ?? null
}

/** Combine a user signal with a timeout signal — whichever fires first. */
function combineSignals(user: AbortSignal | undefined, timeout: AbortSignal | null): AbortSignal | undefined {
  if (!timeout) return user
  if (!user) return timeout
  const composite = new AbortController()
  const onAbort = (reason: unknown) => {
    composite.abort(reason)
  }
  if (user.aborted) {
    composite.abort(user.reason)
  } else if (timeout.aborted) {
    composite.abort(timeout.reason)
  } else {
    user.addEventListener('abort', () => onAbort(user.reason), { once: true })
    timeout.addEventListener('abort', () => onAbort(timeout.reason), { once: true })
  }
  return composite.signal
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms)
  // Node-only: don't keep the event loop alive solely for this timer.
  // In the browser `setTimeout` returns a `number`, so we narrow first.
  if (typeof timer === 'object' && timer !== null) {
    ;(timer as { unref?: () => void }).unref?.()
  }
  return controller.signal
}

function isAbortError(err: unknown): boolean {
  if (!err) return false
  if (err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof Error && err.name === 'AbortError') return true
  if (isObject(err) && typeof err.name === 'string' && err.name === 'AbortError') return true
  return false
}

async function bytesToBase64(bytes: Uint8Array | ArrayBuffer | Blob): Promise<string> {
  const view = await normaliseBytes(bytes)
  // Chunk to avoid `String.fromCharCode.apply` arg limits on very large blobs.
  let binary = ''
  for (let i = 0; i < view.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, Math.min(i + BASE64_CHUNK, view.length)))
  }
  // `btoa` is a Web standard and is present on `globalThis` in Node ≥ 16.
  return btoa(binary)
}

async function normaliseBytes(bytes: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (typeof Blob !== 'undefined' && bytes instanceof Blob) {
    const buffer = await bytes.arrayBuffer()
    return new Uint8Array(buffer)
  }
  throw new FileError({
    code: 'INVALID_ARGUMENT',
    message: 'FileClient.create: bytes must be Uint8Array, ArrayBuffer, or Blob',
    status: 0,
    channel: 'files:create',
  })
}
