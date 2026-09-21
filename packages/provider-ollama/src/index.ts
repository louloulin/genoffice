/**
 * @genoffice/provider-ollama — Ollama provider plugin for GenOffice.
 *
 * Talks to a local Ollama daemon via its OpenAI-compatible surface
 * (`Ollama 0.5+` exposes `/v1/chat/completions`). No API key required;
 * the `apiKey` slot accepts any non-empty string.
 *
 * Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default Ollama OpenAI-compat endpoint (Ollama 0.5+). */
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/** Default model id to seed the picker when Ollama is unreachable. */
export const OLLAMA_DEFAULT_MODEL_ID = 'llama3.2'

export interface OllamaProviderOptions {
  /** Override the Ollama HTTP endpoint. Defaults to `http://localhost:11434/v1`. */
  baseUrl?: string
  /** Override the default model id. Defaults to `llama3.2`. */
  defaultModel?: string
  /** Override the model catalogue. Defaults to a single-entry `[defaultModel]`. */
  models?: string[]
}

export function createOllamaProvider(opts: OllamaProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? OLLAMA_DEFAULT_MODEL_ID
  const models = opts.models ?? [defaultModel]

  const cfg: CompatibleProviderOptions = {
    id: 'ollama',
    label: 'Ollama (local)',
    models,
    defaultModel,
    keyPlaceholder: 'not-required',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: true,
  }
  const plugin = createCompatibleProvider(cfg)
  return {
    ...plugin,
    // Ollama doesn't enforce an API key; let any non-empty string through.
    validate({ apiKey }: { apiKey: string }) {
      if (!apiKey || apiKey.trim().length === 0) {
        throw new Error('Ollama apiKey slot must be a non-empty string (use "ollama" if you have no key)')
      }
    },
  }
}

const plugin = createOllamaProvider()
export default plugin
