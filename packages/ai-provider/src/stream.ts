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
import type { AiProviderConfig, AiProviderId } from './types'

export { streamAnthropic } from './protocols/anthropic'
export { streamGemini } from './protocols/gemini'
export { streamOpenAiCompatible } from './protocols/openai-compatible'
export { AiCreditsError, sseLines } from './protocols/shared'
export type { StreamCallbacks } from './protocols/shared'

/** route a streaming, tool-calling-capable turn by provider id */
export async function streamForProvider(
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
