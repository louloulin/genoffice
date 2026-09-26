/**
 * AI agent (chat) capability — Observable wrapper around `/api/ai/chat`.
 *
 * The web-server `ai:chat` IPC handler does not currently emit per-token
 * deltas; the REST endpoint with `stream: true` is also non-streaming in
 * this build (it returns a single JSON result). To stay useful and let
 * the contract evolve toward real streaming, the SDK exposes an Observable
 * API that:
 *   - Today: emits one `{ type: 'response', message }` event then completes.
 *   - Tomorrow: emits `{ type: 'delta', content }` events as the server
 *     gains that capability, and finishes with a `response` event holding
 *     the assembled assistant message.
 *
 * Consumers should treat `next` as best-effort streaming and only rely on
 * `complete` (with the accumulated `message` from the final `response`
 * event) for the result.
 */
import { requestJson, RequestError, type RequestConfig, type RequestOptions } from '../internal/request'
import { createObservable, type Observable, type Subscription } from './observable'

export type AiAgentEvent =
  | { type: 'response'; message: AiAgentMessage; raw: unknown }
  | { type: 'error'; message: string }

export interface AiAgentMessage {
  role: 'assistant'
  content: string
  /** Optional provider/model name reported back by the server. */
  model?: string
  /** Latency as observed server-side, in milliseconds. */
  elapsedMs?: number
}

export interface AgentInvokeRequest {
  /** OpenAI-style conversation (preferred). */
  messages?: ChatMessage[]
  /** IPC-style shortcut (used by internal callers). */
  user?: string
  system?: string
  settings?: Record<string, unknown>
  /** Skill name (e.g. `doc-skill`, `sheet-skill`) for the `/api/v1/ai/skill/:name` route. */
  skill?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export interface AgentStream {
  subscribe(observer: {
    next?: (event: AiAgentEvent) => void
    error?: (err: unknown) => void
    complete?: () => void
  }): Subscription
}

export class AgentClient {
  constructor(private readonly config: RequestConfig) {
    if (!config.baseUrl) throw new Error('AgentClient: baseUrl is required')
  }

  /**
   * Invoke the chat pipeline. The current server contract emits a single
   * JSON response; the SDK surfaces it as one `response` event followed by
   * `complete`. When the server gains real streaming, callers see multiple
   * `delta` events before the final `response` event.
   */
  invoke(req: AgentInvokeRequest, options: RequestOptions = {}): AgentStream {
    if (!hasUsableInput(req)) {
      throw new RequestError({
        code: 'INVALID_ARGUMENT',
        message: 'invoke: expected `messages` (non-empty) or `user` (non-empty string)',
        status: 0,
        channel: 'ai:agent:invoke',
      })
    }
    const fetchImpl = this.config.fetch ?? globalThis.fetch.bind(globalThis)
    const path = req.skill ? `/api/v1/ai/skill/${encodeURIComponent(req.skill)}` : '/api/v1/ai/chat'
    const channel = req.skill ? `ai:agent:skill:${req.skill}` : 'ai:agent:invoke'

    const observable: Observable<AiAgentEvent> = createObservable<AiAgentEvent>((next, error, complete) => {
      const run = async () => {
        try {
          const headers: Record<string, string> = {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(this.config.defaultHeaders ?? {}),
            ...(options.headers ?? {}),
          }
          const bearer = await resolveBearer(this.config.bearer)
          if (bearer) headers.Authorization = `Bearer ${bearer}`

          const init: RequestInit = {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...req, stream: true }),
          }
          if (options.signal) init.signal = options.signal

          const response = await fetchImpl(`${stripTrailingSlash(this.config.baseUrl)}${path}`, init)
          if (!response.ok) {
            const text = await safeReadText(response)
            throw new RequestError({
              code: mapStatus(response.status),
              message: `${channel}: HTTP ${response.status}` + (text ? ` — ${text}` : ''),
              status: response.status,
              channel,
            })
          }
          const raw = (await response.json()) as unknown
          const message = extractMessage(raw)
          next({ type: 'response', message, raw })
          complete()
        } catch (err) {
          error(err)
        }
      }
      void run()
      return () => {
        // No persistent reader to close in the non-streaming branch.
      }
    })

    return { subscribe: observable.subscribe.bind(observable) }
  }
}

function hasUsableInput(req: AgentInvokeRequest): boolean {
  if (typeof req.user === 'string' && req.user.length > 0) return true
  if (Array.isArray(req.messages) && req.messages.length > 0) return true
  return false
}

function extractMessage(raw: unknown): AiAgentMessage {
  if (typeof raw !== 'object' || raw === null) return { role: 'assistant', content: '' }
  const obj = raw as Record<string, unknown>
  // REST `{ ok, reply, settings, ... }` shape OR IPC `{ message }` shape.
  const reply = pickString(obj, ['reply', 'message', 'content', 'output'])
  if (reply) {
    return {
      role: 'assistant',
      content: reply,
      model: pickString(obj, ['model', 'provider']),
      elapsedMs: pickNumber(obj, ['elapsedMs', 'latencyMs']),
    }
  }
  return { role: 'assistant', content: '' }
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return undefined
}

function pickNumber(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function mapStatus(status: number): RequestError['code'] {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status === 413) return 'PAYLOAD_TOO_LARGE'
  if (status === 400) return 'INVALID_ARGUMENT'
  if (status >= 500) return 'INTERNAL'
  return 'UNKNOWN'
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

async function resolveBearer(bearer: RequestConfig['bearer']): Promise<string | null> {
  if (bearer === undefined || bearer === null) return null
  if (typeof bearer === 'string') return bearer
  return (await bearer()) ?? null
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}