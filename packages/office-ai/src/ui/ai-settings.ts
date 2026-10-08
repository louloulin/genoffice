/**
 * AI provider configuration for the office-ai UI host.
 *
 * Why the host has to own this: in web mode the renderer's agent transport
 * (`createWebTransport` in @genoffice/agent-core) POSTs
 * `{requestId, settings, system, messages, tools, maxTokens}` to
 * `${baseUrl}/api/ai/stream`, but it has no `getSettings` hook — only the IPC
 * transport does — so `request.settings` is `undefined` and `JSON.stringify`
 * drops the key entirely. The localStorage settings object is read for one
 * thing only: the `Authorization: Bearer` header. Nothing about the provider
 * reaches the wire. A host that does not hold a provider config therefore
 * serves an AI panel that reaches the route and has nothing to call.
 */
import type { AiProviderConfig, AiProviderId, AiSettings } from '@genoffice/ai-provider'
import { defaultAiSettings } from '@genoffice/ai-provider'

/**
 * Provider credentials for the UI host. Single provider on purpose: a library
 * consumer mounts one editor into one host process, and "one key talks to one
 * vendor" is the shape they actually have.
 *
 * `codex` is not usable here — it drives a Node subprocess — nor `genspark`,
 * whose auth comes from the gsk login the office-ai host does not carry.
 */
export interface AiHostSettings {
  provider: AiProviderId
  model: string
  apiKey: string
  /** Required for `provider: 'custom'`; any OpenAI-compatible base URL. */
  baseUrl?: string
}
/**
 * Resolve the consumer's single provider into the full settings object both
 * `/api/ai/stream` and `ai:get-settings` read.
 *
 * Every other provider keeps its default model and an empty key, so the
 * renderer's settings UI shows a coherent catalog rather than an empty map.
 */
export function resolveAiHostSettings(ai: AiHostSettings | undefined): AiSettings {
  const settings = defaultAiSettings()
  // No gsk backend in this process, so the renderer's cloud-tool gate must read
  // off — leaving it on advertises tools every request then fails to service.
  settings.gskToolsEnabled = false
  if (!ai) return settings

  settings.provider = ai.provider
  const existing = settings.providers[ai.provider]
  settings.providers[ai.provider] = {
    ...existing,
    apiKey: ai.apiKey,
    model: ai.model || (existing?.model ?? ''),
    baseUrl: ai.baseUrl ?? existing?.baseUrl,
  }
  return settings
}

/**
 * Providers this host cannot serve at all.
 *
 * `genspark` authenticates through the shared gsk login (`~/.genoffice/auth.json`
 * / the gsk CLI) and `codex` drives a Node subprocess; this host carries
 * neither. Both would otherwise look "configured" — genspark ships a default
 * model with an empty key — and the request would go out to the public
 * endpoint, coming back as an opaque 403 instead of a local explanation.
 */
const UNSUPPORTED_PROVIDERS: ReadonlySet<AiProviderId> = new Set(['genspark', 'codex'])

/**
 * Why this config cannot serve a request, or null when it can.
 *
 * Checked before the SSE header is written so the caller gets a precise reason
 * instead of a provider-side 401 turned into an opaque network error.
 */
export function aiConfigProblem(settings: AiSettings): string | null {
  const provider = settings.provider
  if (UNSUPPORTED_PROVIDERS.has(provider)) {
    return `AI provider "${provider}" needs a GenOffice desktop login the office-ai UI host does not carry. Pass \`ai: { provider: 'custom', baseUrl, model, apiKey }\` (or another key-based provider) to startUiHost().`
  }
  const config: AiProviderConfig | undefined = settings.providers?.[provider]
  if (!config) return `AI provider "${provider}" is not configured`
  if (!config.apiKey) {
    return `No API key configured for AI provider "${provider}". Pass \`ai: { provider, model, apiKey }\` to startUiHost().`
  }
  if (!config.model) return `No model selected for AI provider "${provider}".`
  if (provider === 'custom' && !config.baseUrl) {
    return 'AI provider "custom" needs a `baseUrl` pointing at an OpenAI-compatible endpoint.'
  }
  return null
}

/**
 * The browser-facing view of the settings.
 *
 * apiKey is blanked on every entry. `ai:get-settings` reaches the renderer,
 * which reaches whatever can open devtools — the real key stays in the host
 * process where `/api/ai/stream` uses it, and streaming does not depend on the
 * masked value (the web transport never sends it). provider and model are
 * returned truthfully because the panel renders them.
 */
export function redactAiSettings(settings: AiSettings): AiSettings {
  const providers: AiSettings['providers'] = {} as AiSettings['providers']
  for (const [id, config] of Object.entries(settings.providers ?? {})) {
    providers[id as AiProviderId] = { ...config, apiKey: '' }
  }
  return { ...settings, providers }
}
