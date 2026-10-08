/**
 * `POST /api/ai/stream` — the SSE endpoint the renderer's agent loop talks to.
 *
 * Wire contract (fixed by @genoffice/agent-core's `createWebTransport`, and the
 * same one apps/web-server serves):
 *
 *   - one `data: {json}\n\n` frame per event, terminated by `response.end()`;
 *   - **every** frame echoes the caller's `requestId`. The client generates it
 *     with `crypto.randomUUID()` and drops any frame that does not match, so a
 *     missing echo reads to the panel as a stream that produced nothing;
 *   - `delta` / `reasoning` carry `text`, `tool-call` carries `toolCall`,
 *     `done` may carry `stopReason`, `error` carries a human-readable string;
 *   - `ping` is a wire keepalive so the client's watchdog can tell a slow turn
 *     from a dead one.
 *
 * The request body carries no provider selection (see ai-settings.ts), so this
 * handler is the only place the host's credentials are used.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AgentMessage, AgentToolCall, AgentToolDef, AiSettings, AiStreamChunk } from '@genoffice/ai-provider'
import {
  AiCreditsError,
  AiTimeoutError,
  isAiNetworkError,
  isAiOverloadedError,
  isAiQuotaExhaustedError,
  maxOutputTokensOf,
  streamForProvider,
} from '@genoffice/ai-provider'

import type { UiHostContext } from './host'
import { aiConfigProblem } from './ai-settings'
import { MAX_HTTP_BODY_BYTES, readBodyWithCap } from './read-body'

interface StreamRequestBody {
  requestId?: string
  system?: string
  messages?: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

/**
 * Handle `POST /api/ai/stream`. Returns false when the path is not ours so the
 * caller can fall through to its own routing.
 */
export function handleAiStream(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: UiHostContext,
  url: URL,
): boolean {
  if (url.pathname !== '/api/ai/stream') return false
  if (request.method !== 'POST') {
    response.writeHead(405, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'POST required', channel: url.pathname, allow: 'POST' },
      }),
    )
    return true
  }
  void runStream(request, response, ctx)
  return true
}

async function runStream(request: IncomingMessage, response: ServerResponse, ctx: UiHostContext): Promise<void> {
  // Declared before the try so the `finally` and the error path can always see
  // it, even when the body never parsed.
  const streamId = 'sse-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  let requestId = streamId
  let abort: AbortController | undefined

  try {
    let body: StreamRequestBody
    try {
      const raw = await readBodyWithCap(request, MAX_HTTP_BODY_BYTES)
      body = JSON.parse(raw || '{}') as StreamRequestBody
    } catch (error) {
      // Before the SSE header: a real status. After it: an `error` frame.
      throw new AiStreamBadRequest(error instanceof Error ? error.message : String(error))
    }
    if (body.requestId) requestId = String(body.requestId)

    // Everything past this point has flushed 200 + text/event-stream, so the
    // only way out of a failure is a final `error` frame — writing a status
    // code now would raise ERR_HTTP_HEADERS_SENT and hang the stream.
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Request-Id': requestId,
    })

    const send = (chunk: Omit<AiStreamChunk, 'requestId'>): void => {
      try {
        response.write(`data: ${JSON.stringify({ ...chunk, requestId })}\n\n`)
      } catch {
        // Client vanished mid-stream: abort the upstream call rather than keep
        // buying tokens for nobody.
        abort?.abort()
      }
    }

    const problem = aiConfigProblem(ctx.ai)
    if (problem) {
      send({ type: 'error', error: problem })
      return
    }

    abort = new AbortController()
    // The client's only cancel mechanism is aborting its fetch, which surfaces
    // here as a closed request.
    request.on('close', () => abort?.abort())

    await streamTurn(ctx.ai, {
      system: typeof body.system === 'string' ? body.system : '',
      messages: Array.isArray(body.messages) ? body.messages : [],
      tools: Array.isArray(body.tools) ? body.tools : [],
      maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
      signal: abort.signal,
      send,
    })
  } catch (error) {
    if (response.headersSent) {
      sendFrame(response, {
        requestId,
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    } else {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: {
            code: 'INVALID_ARGUMENT',
            message:
              error instanceof AiStreamBadRequest
                ? `/api/ai/stream: ${error.message}`
                : `/api/ai/stream: ${error instanceof Error ? error.message : String(error)}`,
            channel: '/api/ai/stream',
          },
        }),
      )
    }
    abort?.abort()
  } finally {
    try {
      response.end()
    } catch {
      // Already closed by the peer or by a prior error; nothing to do.
    }
  }
}

class AiStreamBadRequest extends Error {}

interface StreamTurnInput {
  system: string
  messages: AgentMessage[]
  tools: AgentToolDef[]
  maxTokens: number | undefined
  signal: AbortSignal
  send: (chunk: Omit<AiStreamChunk, 'requestId'>) => void
}

/**
 * One provider turn, mapped onto SSE frames. Mirrors web-server's
 * `runProviderStream` minus the audit trail, secret store and tenant failover —
 * none of which exist in a single-host library.
 */
async function streamTurn(settings: AiSettings, input: StreamTurnInput): Promise<void> {
  const provider = settings.provider
  const config = settings.providers[provider]!
  let stopReason: string | undefined

  try {
    await streamForProvider(
      provider,
      config,
      input.system,
      input.messages,
      input.tools,
      input.maxTokens ?? maxOutputTokensOf(settings),
      {
        signal: input.signal,
        onDelta: (text) => input.send({ type: 'delta', text }),
        onReasoningDelta: (text) => input.send({ type: 'reasoning', text }),
        onToolCall: (toolCall: AgentToolCall) => input.send({ type: 'tool-call', toolCall }),
        onStopReason: (reason) => {
          stopReason = reason
        },
        onActivity: () => input.send({ type: 'ping' }),
      },
    )
    input.send({ type: 'done', ...(stopReason ? { stopReason } : {}) })
  } catch (error) {
    if (input.signal.aborted) {
      // A client cancel is a normal end of turn, not a failure the panel should
      // render — tokens already delivered stand.
      input.send({ type: 'done' })
      return
    }
    const errorCode =
      error instanceof AiTimeoutError
        ? ('timeout' as const)
        : error instanceof AiCreditsError || isAiQuotaExhaustedError(error)
          ? ('credits' as const)
          : isAiNetworkError(error)
            ? ('network' as const)
            : isAiOverloadedError(error)
              ? ('overloaded' as const)
              : undefined
    input.send({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
      ...(errorCode ? { errorCode } : {}),
    })
  }
}

/** Last-resort writer used by the catch block after headers are flushed. */
function sendFrame(response: ServerResponse, chunk: AiStreamChunk): void {
  try {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  } catch {
    // The peer is gone; the stream ends with the response.
  }
}
