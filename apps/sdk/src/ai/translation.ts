/**
 * Translation pipeline — Observable wrapper around the web-server SSE endpoint.
 *
 * Wire shape (one stream event per SSE `event:`):
 *   { type: 'start',    requestId, sourceLanguage, targetLanguage, totalUnits }
 *   { type: 'unit',     requestId, unit: TranslateBatchUnitResult,
 *                        completedUnits, totalUnits, progress }
 *   { type: 'quality',  requestId, completedUnits, quality: {...} }
 *   { type: 'complete', requestId, status, totalUnits, completedUnits,
 *                        okCount, memoryHitCount, failedCount, warnings, elapsedMs,
 *                        errorMessage? }
 *   { type: 'error',    requestId, message }
 *
 * The server contract is documented at `apps/web-server/src/ai/translate-http.ts:212`.
 * The Observable emits these values as-is — `next` fires once per SSE event,
 * `error` fires on a non-2xx HTTP, malformed SSE, or server `error` event,
 * `complete` fires after the server's `complete` event or when the stream ends.
 *
 * All three calls target the `/api/v1` surface, which — unlike the pre-v1
 * legacy routes — gates on the `ai:translate` scope. A `bearer` must be
 * configured, or every call answers 401/403 before any translation work runs.
 *
 * Cancel:
 *   - The returned `TranslationStream` carries a `.cancel()` that POSTs to
 *     `/api/v1/ai/translate/stream/cancel` with `{ requestId }` and returns the
 *     server-reported status: `'cancelled'` (a session was aborted),
 *     `'completed'` (the stream finished before cancel landed), or
 *     `'unknown'` (server has no record — likely already gc'd).
 *   - Calling `.cancel()` twice is safe; the second call is a no-op.
 *   - Calling `.cancel()` after `complete` is safe and returns `'completed'`.
 */
import { requestJson, RequestError, type RequestConfig, type RequestOptions } from '../internal/request'
import { createObservable, type Observable, type Subscription } from './observable'
import { openSseStream } from './sse'

export type TranslationEvent =
  | TranslationStartEvent
  | TranslationUnitEvent
  | TranslationQualityEvent
  | TranslationCompleteEvent
  | TranslationErrorEvent

export interface TranslationStartEvent {
  type: 'start'
  requestId: string
  sourceLanguage?: string
  targetLanguage?: string
  totalUnits: number
}

export interface TranslationUnitEvent {
  type: 'unit'
  requestId: string
  unit: TranslationUnit
  completedUnits: number
  totalUnits: number
  progress: number
}

export interface TranslationQualityEvent {
  type: 'quality'
  requestId: string
  completedUnits: number
  quality: { overallScore: number; warnings: string[]; passed: boolean }
}

export interface TranslationCompleteEvent {
  type: 'complete'
  requestId: string
  status: 'completed' | 'partial' | 'failed'
  totalUnits: number
  completedUnits: number
  okCount: number
  memoryHitCount: number
  failedCount: number
  warnings: string[]
  elapsedMs: number
  errorMessage?: string
}

export interface TranslationErrorEvent {
  type: 'error'
  requestId?: string
  message: string
}

export interface TranslationUnit {
  unitId: string
  sourceText?: string
  status: 'translated' | 'memory-hit' | 'failed'
  translatedText?: string
  warnings?: string[]
  matchedTerms?: string[]
  errorMessage?: string
  range?: { from?: number; to?: number; scope?: string } | null
}

export interface TranslateRequest {
  units: TranslateUnitRequest[]
  sourceLanguage?: string
  targetLanguage: string
  preserveFormatting?: boolean
  memoryEnabled?: boolean
  qualityCheck?: boolean
  glossaryCategory?: string
  customerName?: string
  scene?: string
  documentId?: string
  documentType?: string
  /** Optional idempotency key — server uses it to dedupe retried batches. */
  idempotencyKey?: string
  /** Override the server-generated request id. */
  requestId?: string
  /** AiSettings override (provider, model, temperature, etc.). */
  settings?: Record<string, unknown>
}

export interface TranslateUnitRequest {
  unitId?: string
  kind?: string
  sourceText: string
  order?: number
  path?: string
  metadata?: Record<string, unknown>
  range?: { from?: number; to?: number; scope?: string } | null
}

export interface TranslateBatchResult {
  ok: boolean
  units: TranslationUnit[]
  okCount: number
  memoryHitCount: number
  failedCount: number
  quality?: { overallScore: number; warnings: string[]; passed: boolean }
}

export type CancelStatus = 'cancelled' | 'completed' | 'unknown'

export interface CancelResponse {
  status: CancelStatus
  requestId: string
}

/**
 * Subscribed handle: cancel() is the only post-subscribe control needed
 * (the underlying SSE reader is closed when the Observable's
 * subscription.unsubscribe() runs).
 */
export interface TranslationStream {
  subscribe(observer: {
    next?: (event: TranslationEvent) => void
    error?: (err: unknown) => void
    complete?: () => void
  }): Subscription
  /** Server-assigned (or caller-supplied) request id. */
  readonly requestId: string
  /** Abort the in-flight stream. Resolves with the resulting status. */
  cancel(): Promise<CancelResponse>
}

export class TranslationClient {
  constructor(private readonly config: RequestConfig) {
    if (!config.baseUrl) throw new Error('TranslationClient: baseUrl is required')
  }

  /**
   * Streaming translation. Returns a `TranslationStream` whose
   * `.subscribe()` yields events as they arrive. Call `.cancel()` to abort
   * an in-flight stream; the SSE reader is also closed via
   * `subscription.unsubscribe()`.
   */
  translate(req: TranslateRequest, options: RequestOptions = {}): TranslationStream {
    if (!Array.isArray(req.units) || req.units.length === 0) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'translate: `units` must be a non-empty array',
        status: 0,
        channel: 'ai:translate:stream',
      })
    }
    if (typeof req.targetLanguage !== 'string' || req.targetLanguage.length === 0) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'translate: `targetLanguage` is required',
        status: 0,
        channel: 'ai:translate:stream',
      })
    }

    const fetchImpl = this.config.fetch ?? globalThis.fetch.bind(globalThis)
    if (typeof fetchImpl !== 'function') {
      throw new RequestError({
        code: 'NETWORK',
        message: 'fetch is unavailable; pass `fetch` in the config',
        status: 0,
        channel: 'ai:translate:stream',
      })
    }

    let requestId = req.requestId ?? ''
    let cancelled = false
    let cancelPromise: Promise<CancelResponse> | null = null
    const selfConfig = this.config

    const observable: Observable<TranslationEvent> = createObservable<TranslationEvent>(
      (next, error, complete) => {
        const baseUrl = stripTrailingSlash(this.config.baseUrl)
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...(this.config.defaultHeaders ?? {}),
          ...(options.headers ?? {}),
        }
        // Combine user abort signal with our internal "cancelled" signal.
        const compositeAbort = new AbortController()
        if (options.signal) {
          if (options.signal.aborted) compositeAbort.abort(options.signal.reason)
          else options.signal.addEventListener('abort', () => compositeAbort.abort(options.signal!.reason), { once: true })
        }

        const run = async (): Promise<void> => {
          let parser: Awaited<ReturnType<typeof openSseStream>>['parser'] | null = null
          try {
            const body = JSON.stringify({ ...req, requestId: req.requestId })
            const bearer = await resolveBearer(this.config.bearer)
            if (bearer) headers.Authorization = `Bearer ${bearer}`
            const { parser: p } = await openSseStream(
              fetchImpl,
              `${baseUrl}/api/v1/ai/translate/stream`,
              { method: 'POST', headers, body, signal: compositeAbort.signal },
              'ai:translate:stream',
            )
            parser = p
            while (true) {
              const evt = await p.next()
              if (evt === null) break
              let payload: TranslationEvent
              try {
                payload = JSON.parse(evt.data) as TranslationEvent
              } catch {
                // Surface non-JSON payloads as a synthetic error event so
                // the consumer can decide what to do.
                next({ type: 'error', requestId, message: `malformed SSE payload: ${evt.data}` })
                continue
              }
              if (!requestId && payload && typeof payload === 'object' && 'requestId' in payload) {
                requestId = String(payload.requestId)
              }
              next(payload)
              if (payload.type === 'complete' || payload.type === 'error') break
            }
            complete()
          } catch (err) {
            if (cancelled) {
              // Caller-initiated cancellation: surface as `complete`, not
              // `error`, so observers can treat it as a normal end-of-stream.
              complete()
              return
            }
            error(err)
          } finally {
            parser?.close()
          }
        }
        void run()

        return () => {
          compositeAbort.abort(new DOMException('unsubscribed', 'AbortError'))
          parserClose()
        }
      },
    )

    function parserClose() {
      // The parser is closed inside the run() finally; nothing to do here
      // beyond aborting the fetch so the reader unblocks.
    }

    const stream: TranslationStream = {
      get requestId() {
        return requestId
      },
      subscribe: observable.subscribe.bind(observable),
      async cancel(): Promise<CancelResponse> {
        if (cancelPromise) return cancelPromise
        cancelled = true
        const id = requestId || ''
        if (!id) {
          // Subscribe hadn't fired yet (no `start` event was emitted).
          // Return 'unknown' rather than failing the call.
          cancelPromise = Promise.resolve({ status: 'unknown', requestId: '' })
          return cancelPromise
        }
        cancelPromise = requestJson<{ ok: boolean; status: CancelStatus }>(
          selfConfig,
          'POST',
          '/api/v1/ai/translate/stream/cancel',
          { requestId: id },
          'ai:translate:stream:cancel',
          { signal: options.signal, timeoutMs: options.timeoutMs ?? 5_000 },
        ).then(
          (r) => ({ status: r.status, requestId: id }),
          () => ({ status: 'unknown' as CancelStatus, requestId: id }),
        )
        return cancelPromise
      },
    }
    return stream
  }

  /**
   * Non-streaming batch. Mirrors `POST /api/v1/ai/translate`. Use when the
   * caller prefers a single JSON response over per-unit updates.
   *
   * The request body is the batch shape `{ units, targetLanguage, ... }`.
   * The v1 route recognises it too — `handleAiTranslate` delegates to the
   * same batch pipeline the legacy route used, so this is a path change and
   * not a contract change.
   */
  async translateBatch(req: TranslateRequest, options: RequestOptions = {}): Promise<TranslateBatchResult> {
    if (!Array.isArray(req.units) || req.units.length === 0) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'translateBatch: `units` must be a non-empty array',
        status: 0,
        channel: 'ai:translate',
      })
    }
    if (typeof req.targetLanguage !== 'string' || req.targetLanguage.length === 0) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'translateBatch: `targetLanguage` is required',
        status: 0,
        channel: 'ai:translate',
      })
    }
    return requestJson<TranslateBatchResult>(
      this.config,
      'POST',
      '/api/v1/ai/translate',
      req,
      'ai:translate',
      options,
    )
  }
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

async function resolveBearer(bearer: RequestConfig['bearer']): Promise<string | null> {
  if (bearer === undefined || bearer === null) return null
  if (typeof bearer === 'string') return bearer
  return (await bearer()) ?? null
}