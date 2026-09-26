/**
 * Collab lock capability — section-level locks on a document.
 *
 * Web-server IPC contract (see `apps/web-server/src/collab/locks.ts`):
 *
 *   - `collab:lock-acquire`  POST /api/ipc/collab:lock-acquire
 *   - `collab:lock-release`  POST /api/ipc/collab:lock-release
 *   - `collab:lock-status`   POST /api/ipc/collab:lock-status
 *
 * A lock is held for 30s; `lockStatus` reports `expired` when the timestamp
 * has passed. A `sectionId` scopes the lock; without one it falls back to
 * the whole-document key (`'document'`).
 *
 * Out of scope: cross-tab event broadcast. Subscribe to the embedded
 * editor's `lock:changed` event when available; W6 will add a proper
 * `collab:events` SSE channel.
 */
import {
  RequestError,
  ipcError,
  requestIpc,
  type RequestConfig,
  type RequestOptions,
} from '../internal/request'

export interface CollabLockClientConfig extends RequestConfig {}

export interface LockAcquireInput {
  docId: string
  userId: string
  sectionId?: string
}

export interface LockAcquireResult {
  ok: true
  lockKey: string
  acquiredAt: number
}

export interface LockAcquireFailure {
  ok: false
  error: string
  lockedBy?: string
  lockedUntil?: number
}

export interface LockStatusEntry {
  sectionId: string
  userId: string
  timestamp: number
  expired: boolean
}

export interface LockStatusResult {
  locks: LockStatusEntry[]
}

export class CollabLockClient {
  readonly #config: CollabLockClientConfig

  constructor(config: CollabLockClientConfig) {
    if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl) {
      throw new TypeError('CollabLockClient: baseUrl is required')
    }
    this.#config = config
  }

  async acquire(
    input: LockAcquireInput,
    options: RequestOptions = {},
  ): Promise<LockAcquireResult> {
    assertArgs(input, 'lock-acquire')
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:lock-acquire',
      { args: [input] },
      'collab:lock-acquire',
      options,
    )
    if (!result || typeof result !== 'object') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CollabLockClient.acquire: malformed response',
        status: 200,
        channel: 'collab:lock-acquire',
        detail: result,
      })
    }
    const error = ipcError(result)
    if (error) {
      // The server returns a structured failure for a held lock — surface
      // it as `CONFLICT` rather than `UNKNOWN` so callers can branch on
      // the code instead of stringly-typed `error` text.
      const conflict = /locked/i.test(error)
      throw new RequestError({
        code: conflict ? 'CONFLICT' : /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: conflict ? 409 : /not found/i.test(error) ? 404 : 200,
        channel: 'collab:lock-acquire',
        detail: result,
      })
    }
    const ok = result as Partial<LockAcquireResult>
    if (typeof ok.lockKey !== 'string' || typeof ok.acquiredAt !== 'number') {
      throw new RequestError({
        code: 'UNKNOWN',
        message: 'CollabLockClient.acquire: response missing { lockKey, acquiredAt }',
        status: 200,
        channel: 'collab:lock-acquire',
        detail: result,
      })
    }
    return { ok: true, lockKey: ok.lockKey, acquiredAt: ok.acquiredAt }
  }

  async release(
    input: LockAcquireInput,
    options: RequestOptions = {},
  ): Promise<{ ok: true }> {
    assertArgs(input, 'lock-release')
    const result = await requestIpc<unknown>(
      this.#config,
      'POST',
      '/api/ipc/collab:lock-release',
      { args: [input] },
      'collab:lock-release',
      options,
    )
    const error = ipcError(result)
    if (error) {
      throw new RequestError({
        code: /not found/i.test(error) ? 'NOT_FOUND' : 'UNKNOWN',
        message: error,
        status: /not found/i.test(error) ? 404 : 200,
        channel: 'collab:lock-release',
        detail: result,
      })
    }
    return { ok: true }
  }

  async status(
    docId: string,
    sectionId: string | undefined,
    options: RequestOptions = {},
  ): Promise<LockStatusResult> {
    if (typeof docId !== 'string' || !docId) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'CollabLockClient.status: docId is required',
        status: 0,
        channel: 'collab:lock-status',
      })
    }
    const result = await requestIpc<{ locks?: unknown }>(
      this.#config,
      'POST',
      '/api/ipc/collab:lock-status',
      { args: [{ docId, sectionId }] },
      'collab:lock-status',
      options,
    )
    if (!result || !Array.isArray(result.locks)) {
      return { locks: [] }
    }
    const locks: LockStatusEntry[] = []
    for (const entry of result.locks) {
      if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as LockStatusEntry).sectionId === 'string' &&
        typeof (entry as LockStatusEntry).userId === 'string' &&
        typeof (entry as LockStatusEntry).timestamp === 'number' &&
        typeof (entry as LockStatusEntry).expired === 'boolean'
      ) {
        locks.push(entry as LockStatusEntry)
      }
    }
    return { locks }
  }
}

function assertArgs(input: LockAcquireInput, op: string): void {
  if (!input || typeof input !== 'object') {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `CollabLockClient.${op}: input is required`,
      status: 0,
      channel: `collab:${op}`,
    })
  }
  if (typeof input.docId !== 'string' || !input.docId) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `CollabLockClient.${op}: docId is required`,
      status: 0,
      channel: `collab:${op}`,
    })
  }
  if (typeof input.userId !== 'string' || !input.userId) {
    throw new RequestError({
      code: 'INVALID_ARGUMENT',
      message: `CollabLockClient.${op}: userId is required`,
      status: 0,
      channel: `collab:${op}`,
    })
  }
}