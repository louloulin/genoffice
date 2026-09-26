/**
 * Collab presence capability — who's currently in the document.
 *
 * Web-server IPC contract (see `apps/web-server/src/collab/sessions.ts`):
 *
 *   - `collab:presence-update`  POST /api/ipc/collab:presence-update
 *   - `collab:presence-list`    POST /api/ipc/collab:presence-list
 *
 * The server keeps an in-memory `PRESENCE[docId]` Map; entries with
 * `lastSeen` older than 60s are pruned on each `list()` call. The SDK's
 * `subscribe()` polls `list()` and emits the current snapshot whenever
 * the membership changes (cheap JSON.stringify diff).
 *
 * W6 will replace the poll with a real `collab:events` SSE channel.
 */
import {
  RequestError,
  ipcError,
  requestIpc,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'
import type { Observer, Subscription } from '../ai/observable'

export interface CollabPresenceClientConfig extends RequestConfig {}

export type PresenceStatus = 'active' | 'idle' | 'away'

export interface PresenceCursor {
  x: number
  y: number
  selection?: { start: number; end: number }
}

export interface PresenceEntry {
  userId: string
  userName: string
  status: PresenceStatus
  lastSeen: number
  cursor?: PresenceCursor
  color: string
}

export interface PresenceUpdateInput {
  docId: string
  userId: string
  userName?: string
  status?: PresenceStatus
  cursor?: PresenceCursor
}

export interface PresenceSubscribeOptions {
  intervalMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_INTERVAL_MS = 1_000
const MIN_INTERVAL_MS = 50

export class CollabPresenceClient {
  readonly #config: CollabPresenceClientConfig

  constructor(config: CollabPresenceClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CollabPresenceClient: baseUrl is required')
    }
    this.#config = config
  }

  async update(input: PresenceUpdateInput, options: RequestOptions = {}): Promise<{ ok: true }> {
    if (!input || typeof input !== 'object') {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabPresenceClient.update: input is required',
        status: 0,
        channel: 'collab:presence-update',
      })
    }
    if (typeof input.docId !== 'string' || !input.docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabPresenceClient.update: docId is required',
        status: 0,
        channel: 'collab:presence-update',
      })
    }
    if (typeof input.userId !== 'string' || !input.userId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabPresenceClient.update: userId is required',
        status: 0,
        channel: 'collab:presence-update',
      })
    }
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:presence-update',
      { args: [input] },
      'collab:presence-update',
      options,
    )
    const error = ipcError(result)
    if (error) {
      throw new RequestError({
        code: /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: /not found/i.test(error) ? 404 : 200,
        channel: 'collab:presence-update',
        detail: result,
      })
    }
    return { ok: true }
  }

  async list(docId: string, options: RequestOptions = {}): Promise<PresenceEntry[]> {
    if (typeof docId !== 'string' || !docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabPresenceClient.list: docId is required',
        status: 0,
        channel: 'collab:presence-list',
      })
    }
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:presence-list',
      { args: [{ docId }] },
      'collab:presence-list',
      options,
    )
    if (!Array.isArray(result)) return []
    const out: PresenceEntry[] = []
    for (const entry of result) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as PresenceEntry).userId === 'string' &&
        typeof (entry as PresenceEntry).userName === 'string'
      ) {
        out.push(entry as PresenceEntry)
      }
    }
    return out
  }

  subscribe(docId: string, observer: Observer<PresenceEntry[]>, options: PresenceSubscribeOptions = {}): Subscription {
    const interval = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS)
    let last: string | null = null
    let closed = false
    const tick = async () => {
      if (closed) return
      try {
        const entries = await this.list(docId, options.signal ? { signal: options.signal } : {})
        if (closed) return
        const sig = JSON.stringify(entries)
        if (sig === last) return
        last = sig
        observer.next?.(entries)
      } catch (err) {
        if (closed) return
        observer.error?.(err)
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), interval) as unknown as { unref?: () => void }
    if (typeof timer.unref === 'function') timer.unref()
    if (options.timeoutMs && options.timeoutMs > 0) {
      const closeTimer = setTimeout(() => {
        closed = true
        clearInterval(timer as unknown as ReturnType<typeof setInterval>)
        observer.complete?.()
      }, options.timeoutMs) as unknown as { unref?: () => void }
      if (typeof closeTimer.unref === 'function') closeTimer.unref()
    }
    if (options.signal) {
      options.signal.addEventListener(
        'abort',
        () => {
          closed = true
          clearInterval(timer as unknown as ReturnType<typeof setInterval>)
        },
        { once: true },
      )
    }
    return {
      get closed() {
        return closed
      },
      unsubscribe() {
        if (closed) return
        closed = true
        clearInterval(timer as unknown as ReturnType<typeof setInterval>)
      },
    }
  }
}