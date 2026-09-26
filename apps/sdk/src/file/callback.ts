/**
 * Generic callback capability — `POST /api/v1/files/:id/callback`.
 *
 * Register an HTTP webhook that receives `file.saved` events for a single
 * file. HMAC-SHA256 signature is added when a `secret` is set on the
 * server.
 *
 * No GET/DELETE routes exist on the v1 surface — subscriptions are managed
 * via the parent `POST` (which overwrites) and the server-side admin tools.
 * If you need to revoke, call this endpoint again with a different URL
 * (or DELETE via the IPC channel `webhooks:remove`).
 */

import {
  RequestError,
  requestJson,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface RegisterCallbackInput {
  fileId: string
  url: string
  /**
   * Whitelist of event names. Defaults to `['file.saved']` when omitted.
   * Pass `[]` to subscribe to all events.
   */
  events?: string[]
}

export interface RegisterCallbackResult {
  ok: true
  fileId: string
  url: string
}

export interface CallbackClientConfig extends RequestConfig {}

export class CallbackClient {
  readonly #config: CallbackClientConfig

  constructor(config: CallbackClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CallbackClient: baseUrl is required')
    }
    this.#config = config
  }

  async register(
    input: RegisterCallbackInput,
    options: RequestOptions = {},
  ): Promise<RegisterCallbackResult> {
    if (!input || typeof input.fileId !== 'string' || !input.fileId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CallbackClient.register: fileId is required',
        status: 0,
        channel: 'files:callback',
      })
    }
    if (!isValidHttpUrl(input.url)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CallbackClient.register: url must be a string with http: or https: scheme',
        status: 0,
        channel: 'files:callback',
      })
    }
    if (input.events !== undefined && !isValidEventList(input.events)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CallbackClient.register: events must be an array of non-empty strings',
        status: 0,
        channel: 'files:callback',
      })
    }
    const body: { url: string; events?: string[] } = { url: input.url }
    if (input.events !== undefined) body.events = input.events

    const raw = await requestJson<{ ok?: unknown; fileId?: unknown; url?: unknown }>(
      this.#config,
      'POST',
      `/api/v1/files/${encodeURIComponent(input.fileId)}/callback`,
      body,
      'files:callback',
      options,
    )
    if (!raw || raw.ok !== true || typeof raw.fileId !== 'string' || typeof raw.url !== 'string') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CallbackClient.register: malformed response',
        status: 201,
        channel: 'files:callback',
        detail: raw,
      })
    }
    return { ok: true, fileId: raw.fileId, url: raw.url }
  }
}

function isValidHttpUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

function isValidEventList(events: unknown): events is string[] {
  if (!Array.isArray(events)) return false
  for (const e of events) {
    if (typeof e !== 'string' || e.length === 0) return false
  }
  return true
}
