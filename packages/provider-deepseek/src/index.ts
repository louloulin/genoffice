/**
 * @genoffice/provider-deepseek — DeepSeek provider plugin for GenOffice.
 *
 * Talks to DeepSeek via its OpenAI-compatible surface
 * (`https://api.deepseek.com/v1/chat/completions`). Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default DeepSeek OpenAI-compat endpoint. */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'

/** Default model id to seed the picker. */
export const DEEPSEEK_DEFAULT_MODEL_ID = 'deepseek-chat'

export interface DeepSeekProviderOptions {
  /** Override the DeepSeek HTTP endpoint. Defaults to `https://api.deepseek.com/v1`. */
  baseUrl?: string
  /** Override the default model id. Defaults to `deepseek-chat`. */
  defaultModel?: string
  /** Override the model catalogue. Defaults to the built-in DeepSeek list. */
  models?: string[]
}

export function createDeepSeekProvider(opts: DeepSeekProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? DEEPSEEK_DEFAULT_MODEL_ID
  const models = opts.models ?? ['deepseek-chat', 'deepseek-reasoner']

  return createCompatibleProvider({
    id: 'deepseek',
    label: 'DeepSeek',
    models,
    defaultModel,
    keyPlaceholder: 'sk-…',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: false,
  })
}

const plugin = createDeepSeekProvider()
export default plugin
