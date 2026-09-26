/**
 * Generic embed-nonce capability — `/api/v1/embed/nonce`.
 *
 * Three endpoints, all under `files:read` scope:
 *   - `POST   /api/v1/embed/nonce`         mint a session (`sessionId`, `nonce`)
 *   - `POST   /api/v1/embed/verify-nonce`  look up + match the nonce
 *   - `DELETE /api/v1/embed/nonce`         eager eviction from the LRU store
 *
 * Zero dataflare coupling. The host SDK that wants to open an iframe
 * session calls these; the iframe itself just receives `?nonce=...&sessionId=...`
 * via the embed URL builder (`buildEmbedUrl`).
 *
 * Zero-deps. Uses `globalThis.fetch`.
 */

import {
  RequestError,
  requestJson,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface EmbedNonceSession {
  sessionId: string
  nonce: string
  expiresAt: number
  ttlMs: number
}

export interface EmbedNonceVerifyOk {
  valid: true
  expiresAt: number
}

export interface EmbedNonceVerifyMiss {
  valid: false
  reason: 'unknown' | 'expired'
}

export type EmbedNonceVerifyResult = EmbedNonceVerifyOk | EmbedNonceVerifyMiss

export interface MintEmbedNonceInput {
  docId: string
  /** TTL in milliseconds. Server caps at 1 hour, defaults to 5 min. */
  ttlMs?: number
}

export interface EmbedNonceClientConfig extends RequestConfig {}

export class EmbedNonceClient {
  readonly #config: EmbedNonceClientConfig

  constructor(config: EmbedNonceClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('EmbedNonceClient: baseUrl is required')
    }
    this.#config = config
  }

  /** Mint a new handshake session for `docId`. */
  async mint(input: MintEmbedNonceInput, options: RequestOptions = {}): Promise<EmbedNonceSession> {
    if (!input || typeof input.docId !== 'string' || !input.docId.trim()) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'EmbedNonceClient.mint: docId is required',
        status: 0,
        channel: 'embed:nonce',
      })
    }
    const body: { docId: string; ttlMs?: number } = { docId: input.docId.trim() }
    if (input.ttlMs !== undefined) {
      if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        throw new RequestError({
          code: 'INVALID_ARGUMENT',
          message: 'EmbedNonceClient.mint: ttlMs must be a positive number',
          status: 0,
          channel: 'embed:nonce',
        })
      }
      body.ttlMs = input.ttlMs
    }
    const raw = await requestJson<{
      sessionId?: unknown
      nonce?: unknown
      expiresAt?: unknown
      ttlMs?: unknown
    }>(this.#config, 'POST', '/api/v1/embed/nonce', body, 'embed:nonce', options)
    if (
      !raw ||
      typeof raw.sessionId !== 'string' ||
      typeof raw.nonce !== 'string' ||
      typeof raw.expiresAt !== 'number' ||
      typeof raw.ttlMs !== 'number'
    ) {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'EmbedNonceClient.mint: malformed response',
        status: 200,
        channel: 'embed:nonce',
        detail: raw,
      })
    }
    return { sessionId: raw.sessionId, nonce: raw.nonce, expiresAt: raw.expiresAt, ttlMs: raw.ttlMs }
  }

  /**
   * Verify a sessionId + nonce pair. Returns `{ valid: false, reason }`
   * (no throw) when the server says "unknown" or "expired" — this is the
   * contract the SDK uses to distinguish "tampered iframe" from "transport
   * error".
   */
  async verify(
    input: { sessionId: string; nonce: string },
    options: RequestOptions = {},
  ): Promise<EmbedNonceVerifyResult> {
    if (!input?.sessionId || !input?.nonce) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'EmbedNonceClient.verify: sessionId and nonce are required',
        status: 0,
        channel: 'embed:verify-nonce',
      })
    }
    const raw = await requestJson<{ valid?: unknown; reason?: unknown; expiresAt?: unknown }>(
      this.#config,
      'POST',
      '/api/v1/embed/verify-nonce',
      { sessionId: input.sessionId, nonce: input.nonce },
      'embed:verify-nonce',
      options,
    )
    if (raw?.valid === true && typeof raw.expiresAt === 'number') {
      return { valid: true, expiresAt: raw.expiresAt }
    }
    if (raw?.valid === false) {
      const reason: 'unknown' | 'expired' = raw.reason === 'expired' ? 'expired' : 'unknown'
      return { valid: false, reason }
    }
    throw new RequestError({
      code: 'UNKNOWN',
      message: 'EmbedNonceClient.verify: malformed response',
      status: 200,
      channel: 'embed:verify-nonce',
      detail: raw,
    })
  }

  /**
   * Eagerly evict a session. Returns `true` when the server had it
   * (and removed it), `false` when it was already gone — never throws
   * for "not found", by design.
   */
  async release(sessionId: string, options: RequestOptions = {}): Promise<boolean> {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'EmbedNonceClient.release: sessionId is required',
        status: 0,
        channel: 'embed:release-nonce',
      })
    }
    const raw = await requestJson<{ released?: unknown }>(
      this.#config,
      'DELETE',
      '/api/v1/embed/nonce',
      { sessionId },
      'embed:release-nonce',
      options,
    )
    return raw?.released === true
  }
}
