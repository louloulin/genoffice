/**
 * Collab cursor capability — broadcast and watch remote cursors.
 *
 * Web-server IPC contract (see `apps/web-server/src/collab/locks.ts`):
 *
 *   - `collab:cursor-update`  POST /api/ipc/collab:cursor-update
 *   - `collab:cursor-list`    POST /api/ipc/collab:cursor-list
 *
 * The server keeps the latest cursor per `(docId, userId)` in
 * `COLLAB_SESSIONS[docId].cursors`. The SDK's `list()` returns the
 * current snapshot; `subscribe()` polls every `intervalMs` ms and
 * delivers a fresh snapshot each tick.
 *
 * Subscribe returns an `Observable`-style handle with `unsubscribe()`
 * and `close()`. A real SSE channel will replace the poll in W6 once
 * `/api/v1/collab/events` ships.
 */
import {
  RequestError,
  ipcError,
  requestIpc,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'
import type { Observer, Subscription } from '../ai/observable'

export interface CollabCursorClientConfig extends RequestConfig {}

export interface CursorPosition {
  x: number
  y: number
  offset: number
}

export interface CursorSelection {
  start: number
  end: number
}

export interface CursorEntry {
  userId: string
  position: CursorPosition
  selection?: CursorSelection
  color: string
}

export interface CursorUpdateInput {
  docId: string
  userId: string
  position: CursorPosition
  selection?: CursorSelection
}

export interface CursorSubscribeOptions {
  /** Poll cadence in ms. Default: 1000. Floor: 50ms. */
  intervalMs?: number
  /** Hard timeout in ms — stops polling after this many ms. Default: infinite. */
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_INTERVAL_MS = 1_000
const MIN_INTERVAL_MS = 50

export class CollabCursorClient {
  readonly #config: CollabCursorClientConfig

  constructor(config: CollabCursorClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CollabCursorClient: baseUrl is required')
    }
    this.#config = config
  }

  async update(input: CursorUpdateInput, options: RequestOptions = {}): Promise<{ ok: true }> {
    if (!input || typeof input !== 'object') {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCursorClient.update: input is required',
        status: 0,
        channel: 'collab:cursor-update',
      })
    }
    if (typeof input.docId !== 'string' || !input.docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCursorClient.update: docId is required',
        status: 0,
        channel: 'collab:cursor-update',
      })
    }
    if (typeof input.userId !== 'string' || !input.userId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCursorClient.update: userId is required',
        status: 0,
        channel: 'collab:cursor-update',
      })
    }
    if (
      !input.position ||
      typeof input.position.x !== 'number' ||
      typeof input.position.y !== 'number' ||
      typeof input.position.offset !== 'number'
    ) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCursorClient.update: position { x, y, offset } is required',
        status: 0,
        channel: 'collab:cursor-update',
      })
    }
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:cursor-update',
      { args: [input] },
      'collab:cursor-update',
      options,
    )
    const error = ipcError(result)
    if (error) {
      throw new RequestError({
        code: /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: /not found/i.test(error) ? 404 : 200,
        channel: 'collab:cursor-update',
        detail: result,
      })
    }
    return { ok: true }
  }

  async list(docId: string, options: RequestOptions = {}): Promise<CursorEntry[]> {
    if (typeof docId !== 'string' || !docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabCursorClient.list: docId is required',
        status: 0,
        channel: 'collab:cursor-list',
      })
    }
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:cursor-list',
      { args: [{ docId }] },
      'collab:cursor-list',
      options,
    )
    if (!Array.isArray(result)) return []
    const out: CursorEntry[] = []
    for (const entry of result) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as CursorEntry).userId === 'string' &&
        typeof (entry as CursorEntry).position === 'object'
      ) {
        out.push(entry as CursorEntry)
      }
    }
    return out
  }

  /**
   * Subscribe to cursor updates for a docId.
   *
   * Polls `list()` on the cadence and pushes each snapshot to the
   * observer. Returns a `Subscription` whose `unsubscribe()` clears the
   * timer — pass it to `EventTarget.addEventListener('abort', …)` to
   * compose with an outer `AbortSignal`.
   */
  subscribe(docId: string, observer: Observer<CursorEntry[]>, options: CursorSubscribeOptions = {}): Subscription {
    const interval = Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS)
    let lastSig: string | null = null
    let closed = false
    const tick = async () => {
      if (closed) return
      try {
        const cursors = await this.list(docId, options.signal ? { signal: options.signal } : {})
        if (closed) return
        // Skip duplicate snapshots to avoid waking React on a tick that
        // didn't actually change anything (cheap structural compare via
        // JSON.stringify — cursors are tiny).
        const sig = JSON.stringify(cursors)
        if (sig === lastSig) return
        lastSig = sig
        observer.next?.(cursors)
      } catch (err) {
        if (closed) return
        observer.error?.(err)
      }
    }
    // Fire one immediately so subscribers don't wait a full interval.
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