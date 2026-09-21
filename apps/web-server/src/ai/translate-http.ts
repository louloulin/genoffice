/**
 * HTTP surface for the AI translation pipeline.
 *
 * Adds three endpoints to the standalone web-server so the Dataflare parent's
 * bridge forwarder (and any other HTTP caller) can drive `translateBatch` /
 * `translateBatchStream` without going through the IPC layer:
 *
 *   POST /api/ai/translate              — non-streaming batch (sync result)
 *   POST /api/ai/translate/stream       — SSE: start / unit / quality / complete / error
 *   POST /api/ai/translate/stream/cancel — abort an in-flight stream by requestId
 *
 * Wire shape intentionally matches the legacy Dataflare `StructuredTranslationStreamEvent`
 * so the existing `apps/docs/src/renderer/web-bridge.ts#aiTranslateBatchStream`
 * consumer can switch the target URL with no field changes:
 *
 *   { type, requestId, status, sourceLanguage, targetLanguage,
 *     totalUnits, completedUnits, progress, unit, quality, warnings, message }
 *
 * The unit payload mirrors the same field names the bridge already parses
 * (`payload.unit.unitId`, `payload.unit.sourceText`, `payload.unit.translatedText`,
 * `payload.unit.status`, `payload.unit.matchedTerms`, `payload.unit.warnings`,
 * `payload.unit.errorMessage`).
 *
 * Settings: the caller may include an `AiSettings` blob to override the
 * server's persisted settings (mirrors `ai:translate-batch`). Falls back to
 * `aiSettings` from `./chat.js`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  AiSettings,
  type AiProviderConfig,
  type AiProviderId,
} from '@genoffice/ai-provider'
import {
  type TranslateBatchUnitResult,
  translateBatch,
  translateBatchStream,
} from '@genoffice/translation-core'

import { MAX_HTTP_BODY_BYTES, readBodyWithCap } from '../common/read-body'
import {
  aiSettings as defaultSettings,
  ensureKbLoaded,
  ensureMemoryLoaded,
  scheduleMemoryFlush,
  sharedKnowledgeBase,
  translationMemory,
} from './chat'

/**
 * The storage the HTTP endpoints translate against.
 *
 * These endpoints are the Dataflare bridge's primary path, and they used to
 * pass no `knowledgeBase` and no `memory` at all: `translateBatch` therefore
 * fell back to the package-level in-memory TM and skipped the KB entirely.
 * Every KB term the UI had just saved was ignored on the HTTP path, and the
 * bucket filter had nothing to filter — a request that named a customer got
 * the same answer as one that did not. Resolve the same singletons the IPC
 * handlers use so both surfaces see one KB and one translation memory.
 *
 * `sharedKnowledgeBase` is a long-lived instance, and the UI writes the KB
 * through the pi session's *other* instance, which writes the same file. A
 * plain `ensureKbLoaded()` therefore served the boot-time snapshot forever:
 * verified on a live server, a term upserted after the first HTTP request was
 * invisible to every later HTTP translation until the process restarted.
 * `refresh()` re-reads only when the file's bytes changed, so a warm path costs
 * one read and no parse.
 */
async function translationStorage(): Promise<{
  knowledgeBase: typeof sharedKnowledgeBase
  memory: typeof translationMemory
}> {
  await Promise.all([ensureKbLoaded(), ensureMemoryLoaded()])
  await sharedKnowledgeBase.refresh().catch(() => false)
  return { knowledgeBase: sharedKnowledgeBase, memory: translationMemory }
}

interface TranslateUnitRequest {
  unitId?: string
  kind?: string
  sourceText?: string
  order?: number
  path?: string
  metadata?: Record<string, unknown>
  range?: { from?: number; to?: number; scope?: string } | null
}

interface TranslateBatchHttpRequest {
  requestId?: string
  idempotencyKey?: string
  documentId?: string
  documentType?: string
  scene?: string
  sourceLanguage?: string
  targetLanguage?: string
  preserveFormatting?: boolean
  memoryEnabled?: boolean
  qualityCheck?: boolean
  glossaryCategory?: string
  units?: TranslateUnitRequest[]
  /** Customer name — narrows the KB to per-customer terms + preferences. */
  customerName?: string
  settings?: AiSettings
}

const TRANSLATE_STREAM_SESSIONS = new Map<string, AbortController>()

function pickSettings(req: TranslateBatchHttpRequest): AiSettings {
  return req.settings || defaultSettings
}

function resolveProvider(req: TranslateBatchHttpRequest): {
  provider: AiProviderId
  config: AiProviderConfig | undefined
} {
  const settings = pickSettings(req)
  const provider = settings.provider
  const config = settings.providers?.[provider]
  return { provider, config }
}

type CoreScope = 'selection' | 'document' | 'paragraph' | 'cell' | 'table'

function castScope(raw: string | undefined): CoreScope | undefined {
  return raw === 'selection' ||
    raw === 'document' ||
    raw === 'paragraph' ||
    raw === 'cell' ||
    raw === 'table'
    ? raw
    : undefined
}

function castRange(raw: TranslateUnitRequest['range']): {
  from?: number
  to?: number
  scope?: CoreScope
} | null {
  if (!raw) return null
  return { from: raw.from, to: raw.to, scope: castScope(raw.scope) }
}

interface CoreUnit {
  unitId: string
  kind: 'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'document'
  sourceText: string
  order: number
  path?: string
  metadata?: Record<string, unknown>
  range?: { from?: number; to?: number; scope?: CoreScope } | null
}

/**
 * Normalise the request's unit list, keeping malformed elements.
 *
 * `units` is untyped JSON off the wire, so an element can be `null` and the
 * list itself can be a string. Reading `.unitId` on a null element used to
 * throw straight out of this function: the synchronous handler answered 500
 * with the raw JavaScript message, and the SSE handler — which writes its 200
 * header *before* calling this — never reached its `response.end()`, so the
 * socket stayed open and the caller hung until its own timeout.
 *
 * The core layer already turns a malformed element into a failed unit that
 * names its own index (`malformedUnitResult`), so hand the element through
 * untouched rather than dropping or dereferencing it. Dropping would silently
 * shorten the batch, and the caller maps results back by position.
 */
function pickInvalidStringField(
  obj: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = obj[field]
    if (value === undefined) continue
    if (typeof value !== 'string') return field
  }
  return null
}

function toCoreUnits(raw: unknown): CoreUnit[] {
  if (!Array.isArray(raw)) return []
  return raw.map((entry): CoreUnit => {
    if (!entry || typeof entry !== 'object') return entry as unknown as CoreUnit
    const u = entry as TranslateUnitRequest
    return {
      unitId: typeof u.unitId === 'string' ? u.unitId : '',
      kind: (u.kind ?? 'paragraph') as CoreUnit['kind'],
      // A non-string is passed through verbatim so the core layer reports it
      // as the shape error it is, rather than this layer inventing "".
      sourceText: u.sourceText as string,
      order: typeof u.order === 'number' ? u.order : 0,
      path: u.path,
      metadata: u.metadata,
      range: castRange(u.range),
    }
  })
}

function writeSseEvent(
  response: ServerResponse,
  name: string,
  payload: unknown,
): void {
  try {
    response.write(`event: ${name}\n`)
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    /* socket may already be closed */
  }
}

/** Translate endpoints share the same body cap as IPC — the helper
 *  is in `common/read-body` and rejects oversized requests with
 *  PAYLOAD_TOO_LARGE (413) instead of pinning the server. */
const readBody = (request: IncomingMessage): Promise<string> =>
  readBodyWithCap(request, MAX_HTTP_BODY_BYTES)

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(payload))
}

/**
 * Handle POST /api/ai/translate — non-streaming batch.
 * Mirrors the `ai:translate-batch` IPC handler exactly; returns the final
 * TranslateBatchResponse shape with HTTP JSON.
 */
export async function handleTranslateBatchHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: TranslateBatchHttpRequest
  try {
    const raw = await readBody(request)
    body = (raw ? JSON.parse(raw) : {}) as TranslateBatchHttpRequest
  } catch {
    // A body that is not JSON is the caller's mistake; answering 500 made the
    // bridge retry a request that can never succeed.
    sendJson(response, 400, { error: { message: 'invalid JSON body', code: 'INVALID_ARGUMENT' } })
    return
  }
  if (body.units !== undefined && !Array.isArray(body.units)) {
    sendJson(response, 400, {
      error: { message: 'expected `units` to be an array', code: 'INVALID_ARGUMENT' },
    })
    return
  }
  // Glossary / customer / language fields arrive straight off the wire. The
  // core layer crashes on a number (`opts.glossaryCategory.trim is not a
  // function`) and on the older `value3.indexOf is not a function` from the
  // `englishLabelFor` path, so guard each here instead of letting it bleed
  // through as a 500.
  const badField = pickInvalidStringField(body as unknown as Record<string, unknown>, [
    'sourceLanguage',
    'targetLanguage',
    'glossaryCategory',
    'customerName',
    'scene',
    'documentId',
    'documentType',
    'requestId',
    'idempotencyKey',
  ])
  if (badField) {
    sendJson(response, 400, {
      error: {
        message: `expected \`${badField}\` to be a string`,
        code: 'INVALID_ARGUMENT',
      },
    })
    return
  }
  try {
    const { provider, config } = resolveProvider(body)
    if (!config) {
      sendJson(response, 400, {
        error: { message: `AI provider "${provider}" not configured`, code: 'PROVIDER_NOT_CONFIGURED' },
      })
      return
    }
    const storage = await translationStorage()
    const result = await translateBatch(
      {
        units: toCoreUnits(body.units) as never,
        sourceLang: body.sourceLanguage,
        targetLang: body.targetLanguage ?? '',
        preserveFormat: body.preserveFormatting,
        scene: body.scene,
        memoryEnabled: body.memoryEnabled,
        qualityCheck: body.qualityCheck,
        glossaryCategory: body.glossaryCategory,
        ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      },
      { provider, config, ...storage },
    )
    sendJson(response, 200, result)
  } catch (error) {
    // A structured `InvalidArgumentError` here means the request shape was
    // wrong (the core layer throws one for a null `request.units`); anything
    // else is a real fault and keeps its 500.
    const asInvalid = error as { code?: string; message?: string }
    if (asInvalid?.code === 'INVALID_ARGUMENT') {
      sendJson(response, 400, {
        error: { message: asInvalid.message ?? 'invalid argument', code: 'INVALID_ARGUMENT' },
      })
    } else {
      sendJson(response, 500, {
        error: { message: (error as Error)?.message ?? String(error) },
      })
    }
  } finally {
    // `translateBatch` only marks the pair dirty; without this the HTTP path
    // kept every memory hit in memory and lost the whole cache on restart.
    // In `finally` so a partially-completed run that then threw still persists
    // the units that did succeed, rather than discarding the whole pass.
    scheduleMemoryFlush()
  }
}

/**
 * Handle POST /api/ai/translate/stream — SSE pipeline.
 *
 * Emits `start` (with totalUnits), one `unit` event per settled unit, an
 * optional `quality` event after the batch completes, a `complete` event with
 * the final counts, and an `error` event if translation fails. The wire shape
 * matches Dataflare's `StructuredTranslationStreamEvent` so the existing
 * `web-bridge.ts` consumer can drop-in replace its target URL.
 */
export async function handleTranslateStreamHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const requestId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  // no initializer: the catch below returns, so body is read only after the
  // JSON parse assignment succeeds
  let body: TranslateBatchHttpRequest
  try {
    const raw = await readBody(request)
    body = (raw ? JSON.parse(raw) : {}) as TranslateBatchHttpRequest
  } catch (error) {
    sendJson(response, 400, { error: { message: 'invalid JSON body' } })
    return
  }

  const overrideRequestId = body.requestId?.trim()
  const effectiveRequestId = overrideRequestId || requestId

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Request-Id': effectiveRequestId,
  })

  const abort = new AbortController()
  TRANSLATE_STREAM_SESSIONS.set(effectiveRequestId, abort)
  request.on('close', () => {
    abort.abort()
    TRANSLATE_STREAM_SESSIONS.delete(effectiveRequestId)
    try {
      response.end()
    } catch {
      /* ignore */
    }
  })

  let completed = 0
  let okCount = 0
  let memoryHitCount = 0
  let failedCount = 0

  // Everything between `writeHead` above and the `finally` at the bottom runs
  // inside this try. Once the 200 has gone out, the only correct way to fail
  // is an `error` event followed by `end()` — a throw that escapes without
  // ending the response leaves the socket open and the caller hanging until
  // its own timeout, with no way to tell why. That is what `toCoreUnits` used
  // to do on a `null` element. Keeping the whole region guarded means the
  // `finally` always runs, so the response always ends.
  try {
    const units = toCoreUnits(body.units)
    if (!Array.isArray(body.units) || units.length === 0) {
      writeSseEvent(response, 'error', {
        type: 'error',
        requestId: effectiveRequestId,
        message: 'expected non-empty `units` array',
      })
      return
    }
    // Same wire-shape guard as the non-streaming endpoint. The earlier entry
    // point already crashed the SSE with `opts.glossaryCategory.trim is not a
    // function` (or `value3.indexOf is not a function` for `sourceLanguage`),
    // which the `try` above would have caught but the response would then be
    // an `error` event with a raw JS message — confusing the caller into
    // chasing the wrong fix. Reject with a structured shape instead.
    const badField = pickInvalidStringField(body as Record<string, unknown>, [
      'sourceLanguage',
      'targetLanguage',
      'glossaryCategory',
      'customerName',
      'scene',
      'documentId',
      'documentType',
      'requestId',
      'idempotencyKey',
    ])
    if (badField) {
      writeSseEvent(response, 'error', {
        type: 'error',
        requestId: effectiveRequestId,
        message: `expected \`${badField}\` to be a string`,
      })
      return
    }
    const { provider, config } = resolveProvider(body)
    if (!config) {
      writeSseEvent(response, 'error', {
        type: 'error',
        requestId: effectiveRequestId,
        message: `AI provider "${provider}" not configured`,
      })
      return
    }

    const startedAt = Date.now()
    writeSseEvent(response, 'start', {
      type: 'start',
      requestId: effectiveRequestId,
      sourceLanguage: body.sourceLanguage ?? 'auto',
      targetLanguage: body.targetLanguage ?? '',
      totalUnits: units.length,
    })

    const storage = await translationStorage()
    const response_ = await translateBatchStream(
      {
        units: units as never,
        sourceLang: body.sourceLanguage,
        targetLang: body.targetLanguage ?? '',
        preserveFormat: body.preserveFormatting,
        scene: body.scene,
        memoryEnabled: body.memoryEnabled,
        qualityCheck: body.qualityCheck,
        glossaryCategory: body.glossaryCategory,
        ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      },
      { provider, config, ...storage },
      {
        // Cancellation already short-circuits the SSE socket via the
        // `AbortController` registered in TRANSLATE_STREAM_SESSIONS, but the
        // core layer still schedules new units until the worker loop notices
        // the abort. Forwarding the signal here lets the core mark every
        // not-yet-started unit as `failed` / `errorMessage: 'aborted'`
        // instead of continuing to spend provider credits on a stream the
        // user has already closed.
        signal: abort.signal,
        concurrency: 25,
        onUnit: ({ total, result }) => {
          if (abort.signal.aborted) return
          completed += 1
          if (result.status === 'translated') okCount += 1
          else if (result.status === 'memory-hit') memoryHitCount += 1
          else if (result.status === 'failed') failedCount += 1
          const unitPayload: TranslateBatchUnitResult & {
            matchedTerms?: string[]
            warnings?: string[]
          } = {
            unitId: result.unitId,
            sourceText: result.sourceText,
            status: result.status,
            warnings: result.warnings,
            range: result.range,
          }
          if (result.translatedText !== undefined) unitPayload.translatedText = result.translatedText
          if (result.errorMessage) unitPayload.errorMessage = result.errorMessage
          if (result.matchedTerms && result.matchedTerms.length > 0) {
            unitPayload.matchedTerms = result.matchedTerms
          }
          writeSseEvent(response, 'unit', {
            type: 'unit',
            requestId: effectiveRequestId,
            unit: unitPayload,
            completedUnits: completed,
            totalUnits: total,
            progress: completed / Math.max(total, 1),
          })
        },
      },
    )
    if (response_.quality) {
      writeSseEvent(response, 'quality', {
        type: 'quality',
        requestId: effectiveRequestId,
        completedUnits: completed,
        quality: {
          overallScore: response_.quality.overallScore ?? 0,
          warnings: response_.quality.warnings ?? [],
          passed: (response_.quality.overallScore ?? 0) >= 0.85,
        },
      })
    }
    const finalStatus = response_.ok
      ? failedCount > 0
        ? 'partial'
        : 'completed'
      : 'failed'
    writeSseEvent(response, 'complete', {
      type: 'complete',
      requestId: effectiveRequestId,
      status: finalStatus,
      totalUnits: units.length,
      completedUnits: completed,
      okCount,
      memoryHitCount,
      failedCount,
      warnings: response_.quality?.warnings ?? [],
      elapsedMs: Date.now() - startedAt,
      ...(response_.error ? { errorMessage: response_.error } : {}),
    })
  } catch (error) {
    if (!abort.signal.aborted) {
      writeSseEvent(response, 'error', {
        type: 'error',
        requestId: effectiveRequestId,
        message: (error as Error)?.message ?? String(error),
      })
    }
  } finally {
    // Every unit `translateBatchStream` settled is already in the memory; a
    // mid-stream abort or provider failure must not throw those away.
    scheduleMemoryFlush()
    TRANSLATE_STREAM_SESSIONS.delete(effectiveRequestId)
    try {
      response.end()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Handle POST /api/ai/translate/stream/cancel — abort an in-flight stream.
 */
export async function handleTranslateStreamCancelHttp(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let requestId: string | undefined
  try {
    const raw = await readBody(request)
    requestId = ((raw ? JSON.parse(raw) : {}) as { requestId?: string }).requestId
  } catch {
    // Same reasoning as the batch endpoint: an unparseable body is a client
    // mistake and a retry with the same bytes will fail identically.
    sendJson(response, 400, { error: { message: 'invalid JSON body', code: 'INVALID_ARGUMENT' } })
    return
  }
  if (!requestId) {
    sendJson(response, 400, {
      error: { message: 'requestId required', code: 'INVALID_ARGUMENT' },
    })
    return
  }
  const session = TRANSLATE_STREAM_SESSIONS.get(requestId)
  if (session) {
    session.abort()
    TRANSLATE_STREAM_SESSIONS.delete(requestId)
  }
  // Not finding the id is not an error: the stream may have finished, or the
  // caller may be cancelling twice. Reporting `aborted: false` lets it tell
  // "nothing to cancel" from "cancelled" without a failure banner.
  sendJson(response, 200, { ok: true, aborted: Boolean(session) })
}
