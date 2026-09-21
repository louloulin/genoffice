/**
 * @genoffice/provider-kimi — Moonshot Kimi provider plugin for GenOffice.
 *
 * Talks to Moonshot Kimi via its OpenAI-compatible surface
 * (`https://api.moonshot.cn/v1/chat/completions`). Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default Moonshot Kimi OpenAI-compat endpoint. */
export const KIMI_DEFAULT_BASE_URL = 'https://api.moonshot.cn/v1'

/** Default model id to seed the picker. */
export const KIMI_DEFAULT_MODEL_ID = 'moonshot-v1-8k'

export interface KimiProviderOptions {
  /** Override the Moonshot Kimi HTTP endpoint. Defaults to `https://api.moonshot.cn/v1`. */
  baseUrl?: string
  /** Override the default model id. Defaults to `moonshot-v1-8k`. */
  defaultModel?: string
  /** Override the model catalogue. Defaults to the built-in Moonshot Kimi list. */
  models?: string[]
}

export function createKimiProvider(opts: KimiProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? KIMI_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? KIMI_DEFAULT_MODEL_ID
  const models = opts.models ?? ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k']

  return createCompatibleProvider({
    id: 'kimi',
    label: 'Moonshot Kimi',
    models,
    defaultModel,
    keyPlaceholder: 'sk-…',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: false,
  })
}

const plugin = createKimiProvider()
export default plugin
