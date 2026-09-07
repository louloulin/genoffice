/**
 * ai/provider — web-server AI chat client backed by @genoffice/ai-provider.
 *
 * Phase 1.3 (LUM-555) replaces the hand-rolled `callMiniMax` + mock
 * `generateAIResponse` chain with the shared multi-provider client. The
 * silent fallback to a canned Chinese template is gone: when the API key
 * is missing or the upstream request fails, callers receive a structured
 * `AiProviderError` carrying a stable code so the UI can surface a clear
 * message instead of a fake assistant reply.
 */

import { chatForProvider, type AiProviderId, type AiSettings } from '@genoffice/ai-provider'

/**
 * Stable error codes emitted by the web-server AI surface. The UI layer
 * matches on `code` rather than the human-readable `message`; messages are
 * allowed to evolve with translations, copy edits, or upstream wording.
 *
 *  - `AI_PROVIDER_KEY_MISSING`: no API key was configured for the selected
 *    provider (env var or per-provider settings both empty).
 *  - `AI_PROVIDER_INVALID_REQUEST`: settings are incomplete (no model,
 *    missing baseUrl for the custom provider, etc.).
 *  - `AI_PROVIDER_REQUEST_FAILED`: upstream call returned a non-OK status,
 *    timed out, or hit a network error. The raw message is preserved.
 */
export type AiProviderErrorCode =
  | 'AI_PROVIDER_KEY_MISSING'
  | 'AI_PROVIDER_INVALID_REQUEST'
  | 'AI_PROVIDER_REQUEST_FAILED'

export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode
  readonly provider: AiProviderId | 'unknown'

  constructor(code: AiProviderErrorCode, message: string, provider: AiProviderId | 'unknown' = 'unknown') {
    super(message)
    this.name = 'AiProviderError'
    this.code = code
    this.provider = provider
  }
}

/** Resolve the env-var name backing a direct provider's API key. */
function envKeyFor(provider: AiProviderId): string | undefined {
  switch (provider) {
    case 'minimax':
      return 'MINIMAX_API_KEY'
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'gemini':
      return 'GEMINI_API_KEY'
    case 'deepseek':
      return 'DEEPSEEK_API_KEY'
    case 'kimi':
      return 'KIMI_API_KEY'
    case 'glm':
      return 'GLM_API_KEY'
    case 'qwen':
      return 'QWEN_API_KEY'
    case 'doubao':
      return 'DOUBAO_API_KEY'
    case 'xai':
      return 'XAI_API_KEY'
    case 'mistral':
      return 'MISTRAL_API_KEY'
    case 'openrouter':
      return 'OPENROUTER_API_KEY'
    default:
      return undefined
  }
}

/** Resolve the env-var name backing a direct provider's base URL override. */
function envBaseUrlFor(provider: AiProviderId): string | undefined {
  switch (provider) {
    case 'minimax':
      return 'MINIMAX_BASE_URL'
    case 'anthropic':
      return 'ANTHROPIC_BASE_URL'
    case 'openai':
      return 'OPENAI_BASE_URL'
    case 'gemini':
      return 'GEMINI_BASE_URL'
    case 'deepseek':
      return 'DEEPSEEK_BASE_URL'
    case 'kimi':
      return 'KIMI_BASE_URL'
    case 'glm':
      return 'GLM_BASE_URL'
    case 'qwen':
      return 'QWEN_BASE_URL'
    case 'doubao':
      return 'DOUBAO_BASE_URL'
    case 'xai':
      return 'XAI_BASE_URL'
    case 'mistral':
      return 'MISTRAL_BASE_URL'
    case 'openrouter':
      return 'OPENROUTER_BASE_URL'
    default:
      return undefined
  }
}

/**
 * Read MINIMAX_API_KEY / MINIMAX_BASE_URL (or the matching env vars for
 * the resolved provider) and merge them into a settings object whose
 * `provider` is set. Falls back to the per-provider settings the caller
 * already holds; env vars only fill in empty slots so a hand-edited
 * settings file still wins.
 */
export function resolveEnvSettings(settings: AiSettings): AiSettings {
  const provider = settings.provider
  const keyEnv = envKeyFor(provider)
  const baseEnv = envBaseUrlFor(provider)
  const existing = settings.providers?.[provider]
  const fromEnv = {
    apiKey: keyEnv ? process.env[keyEnv]?.trim() || '' : '',
    baseUrl: baseEnv ? process.env[baseEnv]?.trim() || undefined : undefined,
  }
  return {
    ...settings,
    providers: {
      ...settings.providers,
      [provider]: {
        apiKey: existing?.apiKey?.trim() || fromEnv.apiKey,
        model: existing?.model || '',
        ...(existing?.baseUrl || fromEnv.baseUrl
          ? { baseUrl: (existing?.baseUrl || fromEnv.baseUrl || '').trim() }
          : {}),
      },
    },
  }
}

/**
 * One-shot chat call routed through @genoffice/ai-provider. Returns the
 * provider's reply, or throws `AiProviderError` on any failure path —
 * callers should treat the thrown error as a structured failure code
 * instead of catching it and returning canned text.
 */
export async function callAiProvider(
  settings: AiSettings,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<{ content: string; id?: string; usage?: unknown }> {
  const provider = settings.provider
  const resolved = resolveEnvSettings(settings)
  const config = resolved.providers?.[provider]

  if (!config?.apiKey) {
    throw new AiProviderError(
      'AI_PROVIDER_KEY_MISSING',
      `No API key configured for provider '${provider}'. Set ${envKeyFor(provider) ?? 'the matching API key env var'} or update AI settings.`,
      provider,
    )
  }
  if (!config.model) {
    throw new AiProviderError(
      'AI_PROVIDER_INVALID_REQUEST',
      `No model selected for provider '${provider}'. Pick a model in AI settings.`,
      provider,
    )
  }

  try {
    const result = await chatForProvider(provider, config, system, user, signal)
    if (!result.ok) {
      throw new AiProviderError(
        'AI_PROVIDER_REQUEST_FAILED',
        result.error || 'AI provider returned an error',
        provider,
      )
    }
    return { content: result.content ?? '' }
  } catch (err) {
    if (err instanceof AiProviderError) throw err
    throw new AiProviderError(
      'AI_PROVIDER_REQUEST_FAILED',
      err instanceof Error ? err.message : String(err),
      provider,
    )
  }
}
