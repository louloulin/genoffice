import { chatAnthropic } from './protocols/anthropic'
import { chatGemini } from './protocols/gemini'
import { chatOpenAiCompatible } from './protocols/openai-compatible'
// Same rationale as stream.ts — import the browser stub so vite/rollup never
// pulls in the Node-only './codex-app-server' module in renderer bundles.
import { chatCodexAppServer } from './codex-app-server.browser'
import { getProviderAdapter, type ResolvedEndpoint } from './registry'
import { getDefaultProviderRegistry } from './provider-plugin'

import type { AiChatResponse, AiProviderConfig, AiProviderId } from './types'
import { AI_CHAT_RESPONSE_TIMEOUT_MS, createStreamWatchdog } from './watchdog'

/**
 * Per-call shaping the caller can request on top of the provider's defaults.
 *
 * `reasoningEffort: 'none'` asks the endpoint to skip its chain-of-thought.
 * Translation / rewriting / extraction are deterministic transforms — the
 * model does not need to think out loud, and on a small local model the
 * reasoning trace can consume the entire output budget before the answer
 * starts. Only endpoints that declare `supportsReasoningEffort` (currently
 * the user-supplied `custom` OpenAI-compatible route) actually receive the
 * field; named vendors are unaffected.
 */
export interface ChatCallOptions {
  reasoningEffort?: 'none'
}

/** route a one-shot (non-streaming, non-tool-calling) chat call by provider id */
export async function chatForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
  options?: ChatCallOptions,
): Promise<AiChatResponse> {
  // Plugin-first (sdk1.md §3.1): if a third-party AiProviderPlugin is registered
  // for this provider id, route through it instead of the legacy wire-protocol
  // adapter. Keeps existing first-party providers on the same call surface
  // without forcing double registration.
  const plugin = getDefaultProviderRegistry().get(provider)
  if (plugin) {
    // The plugin contract receives { settings, system, user }. `settings` is
    // a flat per-call config (apiKey/baseUrl/model) — NOT the global
    // `AiSettings` shape from ./types which carries provider metadata.
    const pluginSettings = {
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
    }
    const pluginConfig = {
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      model: config.model,
    }
    try {
      // Cast: AiChatRequest.settings is typed as AiSettings (legacy shape),
      // but the plugin-fallback consumers pass a flat config. This is a
      // deliberate v1.0 width — providers that need the full settings graph
      // can opt-in via the legacy getProviderAdapter path.
      const result = await plugin.chat(
        { settings: pluginSettings as never, system, user },
        pluginConfig,
      )
      return result
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  // non-streaming: the server generates the full answer before the headers arrive,
  // so the connect phase gets the long budget; the body read then gets the idle budget
  const wd = createStreamWatchdog(signal, AI_CHAT_RESPONSE_TIMEOUT_MS)
  return wd.guard(() => {
    let endpoint: ResolvedEndpoint
    try {
      endpoint = getProviderAdapter(provider).resolveEndpoint(config)
    } catch (e) {
      // config errors (unknown provider, missing base URL) report as a failed reply, not a rejection
      return Promise.resolve({
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
      })
    }
    switch (endpoint.protocol) {
      case 'codex-app-server':
        return chatCodexAppServer(config, system, user, wd.signal)
      case 'anthropic':
        return chatAnthropic(wd, config, system, user, endpoint.baseUrl)
      case 'gemini':
        return chatGemini(wd, config, system, user, endpoint.baseUrl, {
          omitTemperature: endpoint.omitTemperature,
        })
      case 'openai-compatible':
        return chatOpenAiCompatible(wd, endpoint.baseUrl, config, system, user, {
          omitTemperature: endpoint.omitTemperature,
          bodyExtras: {
            ...endpoint.bodyExtras,
            ...(options?.reasoningEffort && endpoint.supportsReasoningEffort
              ? { reasoning_effort: options.reasoningEffort }
              : {}),
          },
        })
    }
  })
}
