/**
 * TranslationClient — Observable wrapper over /api/v1/ai/translate/stream.
 */
import { describe, expect, it } from 'vitest'
import { TranslationClient } from '../../src/ai/translation'
import { errorResponse, jsonResponse, makeMockFetch } from '../internal/mock-fetch'
import { sseAbortedResponse, sseHangingResponse, sseResponse } from '../internal/sse-mock'

const UNIT_REQ = { sourceText: 'hello', order: 0 }

const START = {
  type: 'start',
  requestId: 'r-1',
  sourceLanguage: 'en',
  targetLanguage: 'zh',
  totalUnits: 2,
}
const UNIT1 = {
  type: 'unit',
  requestId: 'r-1',
  unit: { unitId: 'u1', sourceText: 'hello', status: 'translated' as const, translatedText: '你好' },
  completedUnits: 1,
  totalUnits: 2,
  progress: 0.5,
}
const UNIT2 = {
  type: 'unit',
  requestId: 'r-1',
  unit: { unitId: 'u2', sourceText: 'world', status: 'translated' as const, translatedText: '世界' },
  completedUnits: 2,
  totalUnits: 2,
  progress: 1,
}
const COMPLETE = {
  type: 'complete',
  requestId: 'r-1',
  status: 'completed' as const,
  totalUnits: 2,
  completedUnits: 2,
  okCount: 2,
  memoryHitCount: 0,
  failedCount: 0,
  warnings: [],
  elapsedMs: 12,
}

function collectEvents(stream: ReturnType<TranslationClient['translate']>): Promise<{
  events: unknown[]
  completed: boolean
  error: unknown
}> {
  return new Promise((resolve) => {
    const events: unknown[] = []
    let completed = false
    let error: unknown
    stream.subscribe({
      next: (e) => events.push(e),
      error: (e) => {
        error = e
        resolve({ events, completed, error })
      },
      complete: () => {
        completed = true
        resolve({ events, completed, error })
      },
    })
  })
}

describe('TranslationClient.translate — constructor + input validation', () => {
  it('rejects empty baseUrl', () => {
    expect(() => new TranslationClient({ baseUrl: '' })).toThrow(/baseUrl is required/)
  })

  it('throws INVALID_ARGUMENT for empty units', () => {
    const { fetchImpl } = makeMockFetch(() => sseResponse([]))
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    expect(() => c.translate({ units: [], targetLanguage: 'zh' })).toThrow()
  })

  it('throws INVALID_ARGUMENT for missing targetLanguage', () => {
    const { fetchImpl } = makeMockFetch(() => sseResponse([]))
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    expect(() =>
      c.translate({ units: [UNIT_REQ], targetLanguage: '' }),
    ).toThrow(/targetLanguage/)
  })
})

describe('TranslationClient.translate — happy path', () => {
  it('emits start + unit + unit + complete events and resolves requestId', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      sseResponse([{ event: 'start', data: START }, { event: 'unit', data: UNIT1 }, { event: 'unit', data: UNIT2 }, { event: 'complete', data: COMPLETE }]),
    )
    const c = new TranslationClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const stream = c.translate({
      units: [
        { sourceText: 'hello', order: 0 },
        { sourceText: 'world', order: 1 },
      ],
      targetLanguage: 'zh',
      sourceLanguage: 'en',
    })
    expect(stream.requestId).toBe('')
    const { events, completed } = await collectEvents(stream)
    expect(completed).toBe(true)
    expect(stream.requestId).toBe('r-1')
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      'start',
      'unit',
      'unit',
      'complete',
    ])
    expect(events[3]).toMatchObject({ type: 'complete', status: 'completed', okCount: 2 })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('https://x.test/api/v1/ai/translate/stream')
    expect(calls[0].headers.authorization).toBe('Bearer j')
    expect(calls[0].headers.accept).toBe('text/event-stream')
  })

  it('emits SSE events whose payload arrives across multiple chunks', async () => {
    // chunkSize: 1 forces one enqueue per event, exercising the buffer
    // boundary case in openSseStream.
    const { fetchImpl } = makeMockFetch(() =>
      sseResponse([{ event: 'start', data: START }, { event: 'complete', data: COMPLETE }], 200),
    )
    // Override with a chunked version by re-wrapping the same fetchImpl:
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({
      units: [UNIT_REQ],
      targetLanguage: 'zh',
    })
    const { events } = await collectEvents(stream)
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['start', 'complete'])
  })

  it('honours caller-supplied requestId', () => {
    const { fetchImpl } = makeMockFetch(() => sseResponse([]))
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({
      units: [UNIT_REQ],
      targetLanguage: 'zh',
      requestId: 'caller-supplied',
    })
    expect(stream.requestId).toBe('caller-supplied')
  })

  it('surfaces malformed SSE payloads as synthetic error events', async () => {
    const { fetchImpl } = makeMockFetch(() => {
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: bogus\ndata: not-json\n\n`))
          controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify(COMPLETE)}\n\n`))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
    })
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const { events, completed } = await collectEvents(stream)
    expect(events.map((e) => (e as { type: string }).type)).toEqual(['error', 'complete'])
    expect((events[0] as { message: string }).message).toMatch(/malformed SSE/)
    expect(completed).toBe(true)
  })
})

describe('TranslationClient.translate — server error events', () => {
  it('emits server `error` event without terminating the subscription', async () => {
    const ERR = { type: 'error', requestId: 'r-1', message: 'provider failed' }
    const { fetchImpl } = makeMockFetch(() =>
      sseResponse([{ event: 'start', data: START }, { event: 'error', data: ERR }]),
    )
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const { events, completed } = await collectEvents(stream)
    expect(events).toHaveLength(2)
    expect((events[1] as { message: string }).message).toBe('provider failed')
    expect(completed).toBe(true)
  })

  it('500 → INTERNAL when SSE endpoint returns JSON error', async () => {
    const { fetchImpl } = makeMockFetch(() =>
      errorResponse(500, 'INTERNAL', 'boom', 'ai:translate:stream'),
    )
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const { events, error } = await collectEvents(stream)
    expect(error).toBeDefined()
    expect((error as { code: string }).code).toBe('INTERNAL')
    expect(events).toHaveLength(0)
  })
})

describe('TranslationClient.translate — cancel', () => {
  it('cancel() before any event returns status:"unknown"', async () => {
    const { fetchImpl } = makeMockFetch(() => sseHangingResponse())
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const result = await stream.cancel()
    expect(result).toEqual({ status: 'unknown', requestId: '' })
  })

  it('cancel() after start event POSTs to /api/v1/ai/translate/stream/cancel with the requestId', async () => {
    // Two-step mock: first fetch returns the SSE stream; second fetch
    // (cancel) returns a 200 with `{ ok: true, status: 'cancelled' }`.
    let phase = 0
    const { fetchImpl, calls } = makeMockFetch((req) => {
      if (req.url.endsWith('/api/v1/ai/translate/stream/cancel')) {
        phase = 2
        return jsonResponse({ ok: true, status: 'cancelled' })
      }
      phase = 1
      return sseResponse([{ event: 'start', data: START }, { event: 'complete', data: COMPLETE }])
    })
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    // Wait until the start event has populated the requestId.
    const sub = stream.subscribe({ next: () => undefined, complete: () => undefined })
    // Give the producer a tick to dispatch the `start` event.
    await new Promise((r) => setTimeout(r, 10))
    expect(stream.requestId).toBe('r-1')
    const result = await stream.cancel()
    sub.unsubscribe()
    expect(result).toEqual({ status: 'cancelled', requestId: 'r-1' })
    expect(phase).toBe(2)
    expect(calls[1].method).toBe('POST')
    expect(calls[1].url).toBe('https://x.test/api/v1/ai/translate/stream/cancel')
    expect(JSON.parse(calls[1].body!)).toEqual({ requestId: 'r-1' })
  })

  it('cancel() returns "completed" when server says the stream already finished', async () => {
    const { fetchImpl } = makeMockFetch((req) => {
      if (req.url.endsWith('/api/v1/ai/translate/stream/cancel')) {
        return jsonResponse({ ok: true, status: 'completed' })
      }
      return sseResponse([{ event: 'start', data: START }, { event: 'complete', data: COMPLETE }])
    })
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const sub = stream.subscribe({ next: () => undefined, complete: () => undefined })
    await new Promise((r) => setTimeout(r, 10))
    const result = await stream.cancel()
    sub.unsubscribe()
    expect(result.status).toBe('completed')
  })

  it('cancel() is idempotent', async () => {
    const { fetchImpl } = makeMockFetch((req) => {
      if (req.url.endsWith('/api/v1/ai/translate/stream/cancel')) {
        return jsonResponse({ ok: true, status: 'cancelled' })
      }
      return sseResponse([{ event: 'start', data: START }])
    })
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    const stream = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' })
    const sub = stream.subscribe({ next: () => undefined, complete: () => undefined })
    await new Promise((r) => setTimeout(r, 10))
    const [r1, r2] = await Promise.all([stream.cancel(), stream.cancel()])
    sub.unsubscribe()
    expect(r1).toEqual(r2)
  })

  it('an aborted stream leaks no unhandled rejection', async () => {
    // Regression: `SseParser.close()` used to call `reader.cancel()` without
    // handling the returned promise. On a real socket that promise rejects
    // with the abort reason, and an unhandled rejection crashes a Node host.
    // The hanging-stream fixture can't reproduce it (its cancel always
    // resolves) — `sseAbortedResponse` errors the body the way an aborted
    // fetch does, which makes the reader's cancel reject.
    const leaked: unknown[] = []
    const onUnhandled = (reason: unknown) => leaked.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const { fetchImpl } = makeMockFetch(() => sseAbortedResponse())
      const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
      const sub = c.translate({ units: [UNIT_REQ], targetLanguage: 'zh' }).subscribe({
        error: () => undefined,
      })
      await new Promise((r) => setTimeout(r, 20))
      sub.unsubscribe()
      await new Promise((r) => setTimeout(r, 20))
      expect(leaked).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('TranslationClient.translateBatch', () => {
  it('POST /api/v1/ai/translate with a Bearer token and returns the final result', async () => {
    const RESULT = {
      ok: true,
      units: [
        { unitId: 'u1', sourceText: 'hello', status: 'translated', translatedText: '你好' },
      ],
      okCount: 1,
      memoryHitCount: 0,
      failedCount: 0,
    }
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse(RESULT))
    const c = new TranslationClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    const r = await c.translateBatch({
      units: [{ sourceText: 'hello', order: 0 }],
      targetLanguage: 'zh',
    })
    expect(r.ok).toBe(true)
    expect(r.okCount).toBe(1)
    expect(calls[0].url).toBe('https://x.test/api/v1/ai/translate')
    expect(calls[0].method).toBe('POST')
    // The v1 route gates on the `ai:translate` scope; the legacy route did
    // not. Dropping the Authorization header would turn every batch call
    // into a 401 against a real server while the mock stayed green.
    expect(calls[0].headers.authorization).toBe('Bearer j')
  })

  it('forwards inline glossary / memory / cacheScope onto the wire body', async () => {
    const { fetchImpl, calls } = makeMockFetch(() =>
      jsonResponse({ ok: true, units: [], okCount: 0, memoryHitCount: 0, failedCount: 0 }),
    )
    const c = new TranslationClient({ baseUrl: 'https://x.test', bearer: 'j', fetch: fetchImpl })
    await c.translateBatch({
      units: [{ sourceText: 'fabric weight', order: 0 }],
      targetLanguage: 'zh-CN',
      glossary: [{ source: 'fabric weight', target: '克重' }],
      memory: [{ sourceText: 'hello', targetText: '你好' }],
      cacheScope: 'tenant-a',
    })
    // The client's job at this layer is not to drop them. A field the transport
    // forgets is indistinguishable from a feature that does not exist, because
    // the server simply sees a request without it.
    expect(JSON.parse(calls[0].body!)).toMatchObject({
      glossary: [{ source: 'fabric weight', target: '克重' }],
      memory: [{ sourceText: 'hello', targetText: '你好' }],
      cacheScope: 'tenant-a',
    })
  })

  it('rejects empty units at the call site', async () => {
    const { fetchImpl, calls } = makeMockFetch(() => jsonResponse({}))
    const c = new TranslationClient({ baseUrl: 'https://x.test', fetch: fetchImpl })
    await expect(c.translateBatch({ units: [], targetLanguage: 'zh' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    expect(calls).toHaveLength(0)
  })
})