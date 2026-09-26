/**
 * One-call embed-session bootstrap — `openEmbedSession()`.
 *
 * Opening an embedded editor takes three server round-trips and a URL build,
 * in a fixed order:
 *
 *   1. `POST /api/v1/files/:id/jwt`    mint a file-scoped JWT  (`files:read`)
 *   2. `POST /api/v1/embed/nonce`      mint a handshake nonce  (`files:read`)
 *   3. `POST /api/v1/embed/verify-nonce`  confirm the pair round-trips
 *   4. build the iframe URL from (2) + (3)
 *
 * Hosts that hand-roll this get the ordering and the cleanup wrong, so this
 * module does it once. Every step reuses an existing capability client —
 * no new HTTP client, no new transport.
 *
 * Note the scope: this module *produces a session*. It does not mount an
 * iframe and does not import `editor.ts`. Feed the returned values to
 * `createEditor()` yourself (see `EmbedSession` for the exact handoff and
 * the `autoRelease` interaction).
 *
 * Zero dataflare coupling beyond the default URL builder, which is injected
 * through `buildUrl` and can be replaced wholesale.
 */

import {
  RequestError,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'
import { FileJwtClient } from './jwt'
import { EmbedNonceClient } from '../embed/nonce'
import { buildDataflareEmbedUrl } from '../dataflare/host'
import type { DataflareEmbedUrlInput } from '../dataflare/types'

/**
 * Retry policy for the `RequestError.code` values this module raises.
 * Re-exported here (rather than only from `internal/`) because callers of
 * `openEmbedSession` are the ones who need to act on it.
 */
export { isRetryable } from '../internal/request'

export interface EmbedSessionOptions {
  /** Base URL of the GenOffice web-server, e.g. `/office-engine`. Required. */
  baseUrl: string
  /** Document id inside GenOffice. Required. */
  documentId: string
  /** App id (`docs` / `sheets` / `slides` / …). Defaults to `docs`. */
  app?: string
  /** Token carrying `files:read` — both mint calls are scope-gated. */
  bearer?: RequestConfig['bearer']
  /** JWT subject file. Defaults to `documentId`. */
  fileId?: string
  /** JWT lifetime, 30 … 86400 s. Server default is 1 h. */
  ttlSeconds?: number
  /** Mint a single-use JWT (`jti` recorded on first verify). Default false. */
  oneTime?: boolean
  /** Nonce lifetime in ms. Server caps at 1 h, defaults to 5 min. */
  nonceTtlMs?: number
  readonly?: boolean
  locale?: string
  theme?: 'light' | 'dark' | 'system'
  /**
   * Round-trip the minted pair through `verify-nonce` before returning.
   * Defaults to `true`. Verification is non-consuming (only the `DELETE`
   * evicts), so the returned nonce is still usable afterwards.
   */
  verifyNonce?: boolean
  fetch?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  /** Override the iframe URL builder. Defaults to `buildDataflareEmbedUrl`. */
  buildUrl?: (input: DataflareEmbedUrlInput) => string
}

export interface EmbedSession {
  /** iframe URL, credentials included — treat as a secret. */
  url: string
  /** File-scoped JWT. */
  jwt: string
  /** Unix seconds. */
  jwtExp: number
  sessionId: string
  nonce: string
  /** Unix ms. */
  expiresAt: number
  /**
   * Evict the server-side nonce session. Idempotent and best-effort: the
   * same promise is returned on every call, and a transport failure yields
   * `{ released: false }` rather than throwing.
   *
   * Only call this yourself when you pass `sessionBinding.autoRelease: false`
   * to `createEditor`. With the default `autoRelease: true` the editor
   * releases on `destroy()`, and this becomes a no-op reporting
   * `{ released: false }`.
   */
  cleanup(): Promise<{ released: boolean }>
}

const DEFAULT_APP = 'docs'

/**
 * Mint a JWT + nonce pair, verify it, and build the embed URL.
 *
 * Throws `RequestError`. Retryability by code — see `isRetryable`:
 *
 *   | code                  | trigger                                 | retry |
 *   |-----------------------|-----------------------------------------|-------|
 *   | `INVALID_ARGUMENT`    | missing `baseUrl` / `documentId`        | no    |
 *   | `UNAUTHENTICATED`     | 401 from either mint                    | no*   |
 *   | `FORBIDDEN`           | 403 — bearer lacks `files:read`         | no*   |
 *   | `NETWORK` / `INTERNAL`| transport failure or 5xx                | yes   |
 *   | `EMBED_NONCE_INVALID` | `verify-nonce` answered `valid: false`  | no    |
 *
 * (*) not retryable as-is; re-mint after refreshing the bearer.
 *
 * A failed verification releases the session it just minted before
 * throwing, so a tampered/missed handshake does not leave a live nonce
 * sitting in the server's LRU for its full TTL.
 */
export async function openEmbedSession(options: EmbedSessionOptions): Promise<EmbedSession> {
  const channel = 'file:embed:open'
  if (!options || typeof options.baseUrl !== 'string' || !options.baseUrl.trim()) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'openEmbedSession: baseUrl is required',
      status: 0,
      channel,
    })
  }
  if (typeof options.documentId !== 'string' || !options.documentId.trim()) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: 'openEmbedSession: documentId is required',
      status: 0,
      channel,
    })
  }

  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const documentId = options.documentId.trim()
  const app = options.app && options.app.trim() ? options.app.trim() : DEFAULT_APP
  const requestOptions: RequestOptions = {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }
  const config: RequestConfig = {
    baseUrl,
    ...(options.bearer !== undefined ? { bearer: options.bearer } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  }

  const jwtClient = new FileJwtClient(config)
  const nonceClient = new EmbedNonceClient(config)

  const jwt = await jwtClient.mint(
    {
      fileId: options.fileId ?? documentId,
      ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
      ...(options.oneTime !== undefined ? { oneTime: options.oneTime } : {}),
    },
    requestOptions,
  )

  const session = await nonceClient.mint(
    {
      docId: documentId,
      ...(options.nonceTtlMs !== undefined ? { ttlMs: options.nonceTtlMs } : {}),
    },
    requestOptions,
  )

  // Idempotent even before the first call, so the failure path below and the
  // caller's later `cleanup()` share one promise.
  let releasePromise: Promise<{ released: boolean }> | null = null
  const cleanup = (): Promise<{ released: boolean }> => {
    if (releasePromise === null) {
      // Deliberately not the caller's signal: cleanup must still run when the
      // caller aborted (that is exactly when a nonce is most likely orphaned).
      releasePromise = nonceClient
        .release(session.sessionId, options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
        .then((released) => ({ released }))
        .catch(() => ({ released: false }))
    }
    return releasePromise
  }

  if (options.verifyNonce !== false) {
    const verified = await nonceClient.verify(
      { sessionId: session.sessionId, nonce: session.nonce },
      requestOptions,
    )
    if (verified.valid !== true) {
      await cleanup()
      throw new RequestError({
        code: 'EMBED_NONCE_INVALID',
        message: `openEmbedSession: server rejected the minted nonce (${verified.reason})`,
        status: 200,
        channel,
        detail: verified,
      })
    }
  }

  const buildUrl = options.buildUrl ?? buildDataflareEmbedUrl
  const url = buildUrl({
    baseUrl,
    app,
    documentId,
    jwt: jwt.token,
    sessionId: session.sessionId,
    nonce: session.nonce,
    ...(options.readonly !== undefined ? { readonly: options.readonly } : {}),
    ...(options.locale !== undefined ? { locale: options.locale } : {}),
    ...(options.theme !== undefined ? { theme: options.theme } : {}),
  })

  return {
    url,
    jwt: jwt.token,
    jwtExp: jwt.exp,
    sessionId: session.sessionId,
    nonce: session.nonce,
    expiresAt: session.expiresAt,
    cleanup,
  }
}
