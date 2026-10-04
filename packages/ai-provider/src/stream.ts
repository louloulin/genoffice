import type { AgentMessage, AgentToolDef } from './agent-protocol'
import { withOutputCapFallback } from './output-cap'
import { streamAnthropic } from './protocols/anthropic'
import { streamGemini } from './protocols/gemini'
import { streamOpenAiCompatible } from './protocols/openai-compatible'
// Note: import the renderer-safe stub './codex-app-server.browser' instead of
// the Node-only './codex-app-server' (which uses node:crypto/fs/readline). The
// main process wires the real implementation via dynamic import at runtime
// (see apps/*/src/main/*-main.ts). Renderer bundles stay browser-safe.
import { streamCodexAppServer } from './codex-app-server.browser'
import type { StreamCallbacks } from './protocols/shared'
import { getProviderAdapter, type AiProtocol } from './registry'
import { getDefaultProviderRegistry } from './provider-plugin'
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  classifyProviderError,
  isRetryableErrorClass,
  retryBackoffMs,
  sleep,
  type AiRetryPolicy,
  type StreamForProviderOptions,
} from './retry'
import type { AiProviderConfig, AiProviderId } from './types'

export { streamAnthropic } from './protocols/anthropic'
export { streamGemini } from './protocols/gemini'
export { streamOpenAiCompatible } from './protocols/openai-compatible'
export { AiCreditsError, sseLines } from './protocols/shared'
export type { StreamCallbacks } from './protocols/shared'
export type { AiRetryPolicy, ProviderSwitchInfo, StreamForProviderOptions } from './retry'

/**
 * Route a streaming, tool-calling-capable turn by provider id, with per-request
 * retry and optional registry failover.
 *
 * Retry (A15/A56): a request failing with errorCode in {timeout, network,
 * overloaded} is retried with exponential backoff + jitter, at most
 * `options.retry.maxRetries` times (default 3). A streaming attempt is only
 * retried while NO output has reached the caller: once `cb.onDelta` (or a
 * reasoning delta / tool call) has fired, the turn is not retried because the
 * caller already saw partial output and a replay would duplicate it. Credits,
 * auth, content-policy and any other non-429/503/529 4xx fail fast.
 *
 * Failover (A16/A57): when the primary provider is exhausted (retry budget
 * spent, or it failed fast with a non-retryable error) and nothing was emitted,
 * the next provider in `options.fallbackProviders` is tried, in order, until one
 * completes. Each switch is reported through `options.onProviderSwitch` so the
 * caller can write an audit record. Failover is impossible once any output has
 * been delivered.
 */
export async function streamForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  options?: StreamForProviderOptions,
): Promise<void> {
  const retry: Required<AiRetryPolicy> = {
    maxRetries: options?.retry?.maxRetries ?? DEFAULT_MAX_RETRIES,
    baseDelayMs: options?.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
  }
  const resolveConfig = options?.resolveConfig ?? (() => config)
  const onProviderSwitch = options?.onProviderSwitch
  // The primary is always first; a duplicate primary in the fallback list would
  // burn a whole retry budget on an identical request, so drop it.
  const sequence = [provider, ...(options?.fallbackProviders ?? []).filter((id) => id !== provider)]

  // One flag for the whole operation: any output delivered by any provider means
  // neither retry nor failover is safe (the caller already saw partial output).
  let outputEmitted = false
  const guardedCb = trackOutput(cb, () => {
    outputEmitted = true
  })

  let lastError: unknown
  for (let index = 0; index < sequence.length; index++) {
    const currentProvider = sequence[index]!
    const currentConfig = index === 0 ? config : (resolveConfig(currentProvider) ?? config)
    try {
      await streamWithRetry(
        currentProvider,
        currentConfig,
        system,
        messages,
        tools,
        maxTokens,
        guardedCb,
        retry,
        () => outputEmitted,
        cb.signal,
      )
      return
    } catch (err) {
      lastError = err
      const nextProvider = sequence[index + 1]
      // Caller cancel or already-emitted output: nothing more we can safely do.
      if (!nextProvider || cb.signal.aborted || outputEmitted) throw err
      onProviderSwitch?.({
        from: currentProvider,
        to: nextProvider,
        attempt: index + 1,
        reason: classifyProviderError(err),
      })
    }
  }
  throw lastError ?? new Error('streamForProvider failed without an error')
}

/**
 * Run one provider attempt, retrying on a retryable failure while no output has
 * been delivered. `hasEmittedOutput` reads the shared flag owned by the caller
 * (failover loop), so the "retry only before the first byte" rule holds across
 * attempts and providers alike.
 */
async function streamWithRetry(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
  retry: Required<AiRetryPolicy>,
  hasEmittedOutput: () => boolean,
  signal: AbortSignal,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await streamForProviderOnce(provider, config, system, messages, tools, maxTokens, cb)
      return
    } catch (err) {
      // A caller-initiated abort is a cancel, never a retryable failure.
      if (signal.aborted) throw err
      if (!isRetryableErrorClass(classifyProviderError(err))) throw err
      // Streaming caveat: partial output already reached the caller.
      if (hasEmittedOutput()) throw err
      // attempt is 0-based; the first retry happens when attempt === 0.
      if (attempt >= retry.maxRetries) throw err
      await sleep(retryBackoffMs(retry.baseDelayMs, attempt), signal)
    }
  }
}

/**
 * Wrap the caller's callbacks so the first output-bearing emission flips a flag.
 * Text deltas are the trigger named by the spec; reasoning deltas and tool calls
 * are also output the caller has already seen, so a retry after either would
 * duplicate them — track all three.
 */
function trackOutput(cb: StreamCallbacks, onOutput: () => void): StreamCallbacks {
  const guarded: StreamCallbacks = {
    ...cb,
    onDelta: (text: string) => {
      onOutput()
      cb.onDelta(text)
    },
    onToolCall: (call) => {
      onOutput()
      cb.onToolCall(call)
    },
  }
  if (cb.onReasoningDelta) {
    const emitReasoning = cb.onReasoningDelta
    guarded.onReasoningDelta = (text: string) => {
      onOutput()
      emitReasoning(text)
    }
  }
  return guarded
}

/** one provider attempt: plugin path first, then the wire-protocol adapter path */
async function streamForProviderOnce(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  const plugin = getDefaultProviderRegistry().get(provider)
  if (plugin) {
    const settings = {
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
    }
    const request = {
      requestId: cb.sessionId ?? '',
      settings: settings as never,
      system,
      messages,
      ...(tools.length ? { tools } : {}),
      maxTokens,
    }
    for await (const chunk of plugin.streamChat(request, settings as never)) {
      if (chunk.type === 'delta' && chunk.text) cb.onDelta(chunk.text)
      else if (chunk.type === 'reasoning' && chunk.text) cb.onReasoningDelta?.(chunk.text)
      else if (chunk.type === 'tool-call' && chunk.toolCall) cb.onToolCall(chunk.toolCall)
      else if (chunk.type === 'ping') cb.onActivity?.()
      else if (chunk.type === 'error') {
        cb.onActivity?.()
        throw new Error(chunk.error ?? 'plugin stream error')
      } else if (chunk.type === 'done') {
        if (chunk.stopReason) cb.onStopReason?.(chunk.stopReason)
        return
      }
    }
    return
  }

  const endpoint = getProviderAdapter(provider).resolveEndpoint(config)
  const { baseUrl } = endpoint
  if (endpoint.protocol === 'codex-app-server') {
    return streamCodexAppServer(config, system, messages, tools, maxTokens, cb)
  }
  const protocol: Exclude<AiProtocol, 'codex-app-server'> = endpoint.protocol
  return withOutputCapFallback(baseUrl, config.model, maxTokens, (cap) => {
    switch (protocol) {
      case 'anthropic':
        return streamAnthropic(config, system, messages, tools, cap, cb, baseUrl)
      case 'gemini':
        return streamGemini(config, system, messages, tools, cap, cb, baseUrl, {
          omitTemperature: endpoint.omitTemperature,
        })
      case 'openai-compatible':
        return streamOpenAiCompatible(baseUrl, config, system, messages, tools, cap, cb, {
          omitTemperature: endpoint.omitTemperature,
          useMaxCompletionTokens: endpoint.useMaxCompletionTokens,
          bodyExtras: endpoint.bodyExtras,
        })
    }
  })
}
