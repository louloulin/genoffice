/**
 * Agent Loop Protocol — sdk1.md §3.4.
 *
 * `genoffice.agent.v1` is a JSON envelope that any third-party Agent
 * runner can speak to interoperate with the GenOffice runtime. We
 * deliberately keep the surface tiny so an alternative runtime (LangChain,
 * AutoGPT, a hand-rolled loop) can be wired in without a fork.
 *
 * Wire shape (a complete agent invocation is a single JSON object):
 *
 *   {
 *     v: 'genoffice.agent.v1',
 *     goal: '…',
 *     context: { files?, skills?, kb? },
 *     maxSteps: 8,
 *     onToken?: (token) => void,
 *     onStep?: (step) => void,
 *   }
 *
 * The `onToken` / `onStep` callbacks are optional because the runner is
 * expected to implement progress streaming in whatever shape its own
 * transport prefers (SSE, WebSocket, stdio). The runtime forwards these
 * callbacks verbatim.
 *
 * Stability:
 *   - The request envelope is v1.x. Optional fields may be added at minor
 *     versions; required fields cannot be renamed or removed until v2.
 *   - `AgentStep` is the canonical step shape — third-party runners MUST
 *     emit it; the runtime ignores extra fields but reads these.
 */

import type { AgentMessage } from '@genoffice/ai-provider'

// ──────────────────────────────────────────────────────────────────────────────
// Request
// ──────────────────────────────────────────────────────────────────────────────

export const AGENT_PROTOCOL_VERSION = 'genoffice.agent.v1' as const

/** FileRef is reused from the Skill protocol so the Agent can pre-resolve
 *  workspace files without duplicating the shape. */
export interface AgentFileRef {
  id: string
  name: string
  mimeType: string
  bytes?: Uint8Array
}

export interface AgentContext {
  /** Files available to the agent in the current workspace. */
  files?: AgentFileRef[]
  /** Skill ids the agent may invoke; empty / undefined = all. */
  skills?: string[]
  /** KB ids the agent may search; empty / undefined = none. */
  kb?: string[]
  /** Locale preference (`zh-CN`, `en-US`). */
  locale?: string
  /** Per-call overrides; merged into the agent's effective settings. */
  model?: string
  temperature?: number
}

export interface AgentRequest {
  v: typeof AGENT_PROTOCOL_VERSION
  goal: string
  context?: AgentContext
  /** Maximum number of steps before the runtime forcibly terminates the loop. */
  maxSteps: number
  /**
   * Optional streaming callbacks. Third-party runners that don't speak
   * this shape can omit them and rely on the request's `signal` for
   * cancellation instead.
   */
  onToken?: (token: string) => void
  onStep?: (step: AgentStep) => void
  /** AbortSignal for cancellation (Web standard). */
  signal?: AbortSignal
}

// ──────────────────────────────────────────────────────────────────────────────
// Step
// ──────────────────────────────────────────────────────────────────────────────

export type AgentToolName = string

export interface AgentStep {
  /** Zero-based step index. */
  index: number
  /** The agent's reasoning for this step. */
  thought: string
  /** Tool the agent invoked this step. `'final'` for terminal steps. */
  tool: AgentToolName | 'final'
  /** Inputs passed to the tool. */
  input: Record<string, unknown>
  /** Output the tool returned (shape depends on the tool). */
  output: unknown
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** When the tool failed, the structured error. */
  error?: { code: string; message: string }
  /** Wall-clock timestamp (ms). */
  ts: number
}

// ──────────────────────────────────────────────────────────────────────────────
// Result
// ──────────────────────────────────────────────────────────────────────────────

export type AgentStopReason = 'completed' | 'max-steps' | 'cancelled' | 'error' | 'no-tool'

export interface AgentResult {
  v: typeof AGENT_PROTOCOL_VERSION
  /** Final assistant message; always present when `stopReason !== 'error'`. */
  finalMessage: AgentMessage
  /** All steps the runner took, in order. */
  steps: AgentStep[]
  /** Why the loop stopped. */
  stopReason: AgentStopReason
  /** Total wall-clock duration (ms). */
  durationMs: number
  /** Number of LLM tokens consumed (best-effort). */
  tokensUsed?: number
}

// ──────────────────────────────────────────────────────────────────────────────
// Runner interface — what GenOffice runtime expects from third-party runners
// ──────────────────────────────────────────────────────────────────────────────

export interface AgentRunner {
  /** Stable id; used by the marketplace. */
  id: string
  /** Display label. */
  label: string
  /** Run an agent request to completion. The runner is responsible for
   *  honouring `request.signal` and `request.maxSteps`. */
  run(request: AgentRequest): Promise<AgentResult>
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation helpers (the runtime uses these before handing a request to a
// runner; they are exported so third-party runners can share the contract)
// ──────────────────────────────────────────────────────────────────────────────

export function validateAgentRequest(input: Partial<AgentRequest>): AgentRequest {
  if (!input || typeof input !== 'object') throw new AgentProtocolError('request must be an object')
  if (input.v !== AGENT_PROTOCOL_VERSION) throw new AgentProtocolError(`unsupported protocol version: ${String(input.v)}`)
  if (typeof input.goal !== 'string' || !input.goal) throw new AgentProtocolError('goal is required')
  if (typeof input.maxSteps !== 'number' || input.maxSteps < 1 || input.maxSteps > 1000) {
    throw new AgentProtocolError('maxSteps must be a number between 1 and 1000')
  }
  return {
    v: AGENT_PROTOCOL_VERSION,
    goal: input.goal,
    maxSteps: input.maxSteps,
    ...(input.context ? { context: input.context } : {}),
    ...(input.onToken ? { onToken: input.onToken } : {}),
    ...(input.onStep ? { onStep: input.onStep } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  }
}

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentProtocolError'
  }
}
