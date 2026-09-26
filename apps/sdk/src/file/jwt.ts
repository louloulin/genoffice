/**
 * Generic file-JWT capability — `POST /api/v1/files/:id/jwt`.
 *
 * Mint a short-lived, file-scoped JWT bound to a single document id. The
 * token can be passed to the embed URL (`?token=...`).
 *
 * Honours two client-controlled options:
 *
 *   - **TTL**: `ttlSeconds` in the request body caps the token's lifetime.
 *     Range: 30 s … 24 h. Defaults to 1 h.
 *   - **Single use**: when `oneTime: true`, the token carries a unique
 *     `jti` and is recorded in the server's revocation set on first verify.
 *
 * Zero dataflare coupling.
 */

import {
  RequestError,
  requestJson,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface FileJwtInput {
  fileId: string
  /** Range 30 … 86400. Defaults to 3600 on the server. */
  ttlSeconds?: number
  /** Mint a single-use token (jti recorded on first verify). */
  oneTime?: boolean
}

export interface FileJwtResult {
  token: string
  exp: number
  ttlSeconds: number
  oneTime: boolean
  /** Present only when `oneTime: true`. */
  jti?: string
}

export interface FileJwtClientConfig extends RequestConfig {}

const TTL_MIN_SEC = 30
const TTL_MAX_SEC = 86_400

export class FileJwtClient {
  readonly #config: FileJwtClientConfig

  constructor(config: FileJwtClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('FileJwtClient: baseUrl is required')
    }
    this.#config = config
  }

  async mint(input: FileJwtInput, options: RequestOptions = {}): Promise<FileJwtResult> {
    if (!input || typeof input.fileId !== 'string' || !input.fileId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'FileJwtClient.mint: fileId is required',
        status: 0,
        channel: 'files:jwt',
      })
    }
    const body: Record<string, string> = {}
    if (input.ttlSeconds !== undefined) {
      if (
        !Number.isFinite(input.ttlSeconds) ||
        !Number.isInteger(input.ttlSeconds) ||
        input.ttlSeconds < TTL_MIN_SEC ||
        input.ttlSeconds > TTL_MAX_SEC
      ) {
        throw new RequestError({
          code: 'INVALID_ARGUMENT',
          message: `FileJwtClient.mint: ttlSeconds out of range (${TTL_MIN_SEC}..${TTL_MAX_SEC})`,
          status: 0,
          channel: 'files:jwt',
        })
      }
      body.ttlSeconds = String(input.ttlSeconds)
    }
    if (input.oneTime) body.oneTime = 'true'

    const raw = await requestJson<{
      token?: unknown
      exp?: unknown
      ttlSeconds?: unknown
      oneTime?: unknown
      jti?: unknown
    }>(
      this.#config,
      'POST',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/jwt`,
      body,
      'files:jwt',
      options,
    )
    if (
      !raw ||
      typeof raw.token !== 'string' ||
      typeof raw.exp !== 'number' ||
      typeof raw.ttlSeconds !== 'number' ||
      typeof raw.oneTime !== 'boolean'
    ) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'FileJwtClient.mint: malformed response',
        status: 200,
        channel: 'files:jwt',
        detail: raw,
      })
    }
    return {
      token: raw.token,
      exp: raw.exp,
      ttlSeconds: raw.ttlSeconds,
      oneTime: raw.oneTime,
      ...(typeof raw.jti === 'string' ? { jti: raw.jti } : {}),
    }
  }
}
