/**
 * SSE wire helpers — build `Response`s with a `ReadableStream` body that
 * emits event chunks in the same shape `apps/web-server/src/ai/translate-http.ts`
 * uses, so capability tests can drive the SDK's SSE parser without standing
 * up a server.
 */
export function sseResponse(events: Array<{ event: string; data: unknown }>, status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(
          encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
        )
      }
      controller.close()
    },
  })
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

/**
 * Build an SSE response that emits events in chunks (one event per
 * enqueue), so tests can verify the parser handles partial reads / the
 * buffer accumulating across multiple `.read()` calls.
 */
export function sseChunkedResponse(events: Array<{ event: string; data: unknown }>, chunkSize = 1): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0
      while (i < events.length) {
        const slice = events.slice(i, i + chunkSize)
        i += chunkSize
        for (const e of slice) {
          controller.enqueue(
            encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`),
          )
        }
      }
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * SSE response that never closes on its own — useful for testing the
 * cancel path (the SDK must abort the reader when cancel() is called).
 */
export function sseHangingResponse(): Response {
  const body = new ReadableStream<Uint8Array>({
    start() {
      /* never enqueues, never closes */
    },
    cancel() {
      /* resolves when the consumer cancels */
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

/**
 * SSE response whose body errors with the given reason, modelling a real
 * fetch whose `AbortSignal` fires after the response headers are in.
 *
 * This is the fixture `sseHangingResponse` cannot be: a reader over an
 * *errored* stream rejects its `cancel()` promise with the stored error
 * (per the Streams spec), whereas the hanging stream's `cancel()` always
 * resolves. An SDK that calls `reader.cancel()` without handling that
 * rejection therefore only misbehaves on a real socket — which is exactly
 * the class of bug the live probe exists to catch.
 */
export function sseAbortedResponse(
  reason: unknown = new DOMException('unsubscribed', 'AbortError'),
): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      setTimeout(() => controller.error(reason), 0)
    },
  })
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}