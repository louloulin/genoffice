/**
 * Internal HTTP transport shared by every capability module.
 *
 * Not exported as a public sub-path. Capability modules (`file/management`,
 * `file/versions`, `file/comments`, `file/callback`, `file/jwt`,
 * `embed/nonce`) each own their own config object but delegate the
 * request envelope to `requestJson` / `requestVoid`.
 *
 * This module is deliberately small (~150 LoC). It is NOT a generic HTTP
 * client — it is the minimum needed to hit `apps/web-server/src/api/v1/*`
 * with auth, timeout, and structured error mapping.
 */

export type RequestErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PAYLOAD_TOO_LARGE'
  | 'NOOP'
  | 'CONFLICT'
  | 'INTERNAL'
  | 'NETWORK'
  | 'ABORTED'
  | 'EMBED_NONCE_INVALID'
  | 'UNKNOWN'

const KNOWN_CODES = new Set<RequestErrorCode>([
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'PAYLOAD_TOO_LARGE',
  'NOOP',
  'CONFLICT',
  'INTERNAL',
  'NETWORK',
  'ABORTED',
  'EMBED_NONCE_INVALID',
  'UNKNOWN',
])

/**
 * Whether retrying the same call could plausibly succeed.
 *
 * Only transport-level faults are retryable. Everything else is a property
 * of the request or the credentials, so a second identical attempt fails
 * identically — and for `EMBED_NONCE_INVALID` it is actively wrong, since
 * the nonce was single-use and the retry races the session it just failed
 * to confirm.
 */
export function isRetryable(code: RequestErrorCode): boolean {
  return code === 'NETWORK' || code === 'INTERNAL'
}

export class RequestError extends Error {
  readonly code: RequestErrorCode
  readonly status: number
  readonly channel: string
  readonly detail: unknown

  constructor(input: {
    code: RequestErrorCode
    message: string
    status: number
    channel: string
    detail?: unknown
    cause?: unknown
  }) {
    super(input.message)
    this.name = 'RequestError'
    this.code = input.code
    this.status = input.status
    this.channel = input.channel
    this.detail = input.detail
    if (input.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = input.cause
    }
  }
}

export interface RequestConfig {
  baseUrl: string
  bearer?: string | null | (() => string | null | Promise<string | null>)
  fetch?: typeof fetch
  defaultHeaders?: Record<string, string>
  timeoutMs?: number
}

export interface RequestOptions {
  signal?: AbortSignal
  headers?: Record<string, string>
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Send a request and parse the JSON response. Throws `RequestError` on any
 * non-2xx response, network failure, timeout, or abort.
 */
export async function requestJson<T = unknown>(
  config: RequestConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  channel: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await send(config, method, path, body, channel, options)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Send a request to an `/api/ipc/<channel>` endpoint and unwrap the IPC
 * envelope.
 *
 * The dispatcher in `apps/web-server/src/index.ts` answers **every** IPC
 * channel with the same outer shape, regardless of what the handler returned:
 *
 * ```jsonc
 * { "ok": true, "result": <handler return value> }
 * ```
 *
 * The outer `ok` reports whether the *dispatch* succeeded — it is not the
 * handler's own verdict. A handler that "failed" still comes back as
 * `ok: true` with a `result` of `{ ok: false, error: "…" }`. So callers must
 * inspect `result`, not the envelope, to learn what happened.
 *
 * Returns `result`. Throws `RequestError` only when the envelope itself is
 * malformed (or the transport failed).
 */
export async function requestIpc<T = unknown>(
  config: RequestConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  channel: string,
  options: RequestOptions = {},
): Promise<T> {
  const raw = await requestJson<unknown>(config, method, path, body, channel, options)
  if (!isObject(raw) || raw.ok !== true) {
    throw new RequestError({
      code: 'UNKNOWN',
      message: `${channel}: IPC envelope is missing { ok: true }`,
      status: 200,
      channel,
      detail: raw,
    })
  }
  return raw.result as T
}

/**
 * Normalise a handler's own failure marker. Handlers signal "I could not do
 * that" by returning `{ ok: false, error: '…' }` *inside* `result` — this
 * extracts the message, or `null` when the value is a success.
 */
export function ipcError(value: unknown): string | null {
  if (isObject(value) && value.ok === false) {
    return typeof value.error === 'string' && value.error ? value.error : 'operation failed'
  }
  return null
}

/**
 * Send a request whose success body is irrelevant (e.g. DELETE returning
 * 204). Throws `RequestError` on non-2xx, network failure, or abort.
 */
export async function requestVoid(
  config: RequestConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  channel: string,
  options: RequestOptions = {},
): Promise<void> {
  await send(config, method, path, body, channel, options)
}

async function send(
  config: RequestConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  channel: string,
  options: RequestOptions,
): Promise<Response> {
  const baseUrl = stripTrailingSlash(config.baseUrl)
  const url = `${baseUrl}${path}`
  const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = combineSignals(options.signal, timeoutMs > 0 ? timeoutSignal(timeoutMs) : null)

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(config.defaultHeaders ?? {}),
    ...(options.headers ?? {}),
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const bearer = await resolveBearer(config.bearer)
  if (bearer) headers.Authorization = `Bearer ${bearer}`

  const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis)
  if (typeof fetchImpl !== 'function') {
    throw new RequestError({
      code: 'NETWORK',
      message: 'fetch is unavailable; pass `fetch` in the config',
      status: 0,
      channel,
    })
  }

  let response: Response
  try {
    const init: RequestInit = { method, headers, signal }
    if (body !== undefined) init.body = JSON.stringify(body)
    response = await fetchImpl(url, init)
  } catch (err) {
    if (isAbortError(err)) {
      throw new RequestError({
        code: 'ABORTED',
        message: 'request aborted',
        status: 0,
        channel,
        cause: err,
      })
    }
    throw new RequestError({
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
    throw new RequestError({
      code,
      message: pickMessage(errBody, response, channel),
      status: response.status,
      channel,
      detail: errBody,
    })
  }
  return response
}

// ── Helpers (module-local to keep tree-shaking honest) ──────────────────────

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

async function resolveBearer(bearer: RequestConfig['bearer']): Promise<string | null> {
  if (bearer === undefined || bearer === null) return null
  if (typeof bearer === 'string') return bearer
  const value = await bearer()
  return value ?? null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pickCode(body: unknown, status: number): RequestErrorCode {
  if (isObject(body) && isObject(body.error) && typeof body.error.code === 'string') {
    const code = body.error.code
    if (KNOWN_CODES.has(code as RequestErrorCode)) return code as RequestErrorCode
  }
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 409) return 'CONFLICT'
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

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

function combineSignals(
  user: AbortSignal | undefined,
  timeout: AbortSignal | null,
): AbortSignal | undefined {
  if (!timeout) return user
  if (!user) return timeout
  const composite = new AbortController()
  if (user.aborted) {
    composite.abort(user.reason)
  } else if (timeout.aborted) {
    composite.abort(timeout.reason)
  } else {
    const onAbort = (reason: unknown) => composite.abort(reason)
    user.addEventListener('abort', () => onAbort(user.reason), { once: true })
    timeout.addEventListener('abort', () => onAbort(timeout.reason), { once: true })
  }
  return composite.signal
}

function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), ms)
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
