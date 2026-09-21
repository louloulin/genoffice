/**
 * @genoffice/provider-qwen — Qwen (DashScope) provider plugin for GenOffice.
 *
 * Talks to Qwen (DashScope) via its OpenAI-compatible surface. Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 *
 * Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1`. needsBaseUrl=False.
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default Qwen (DashScope) OpenAI-compat endpoint. */
export const QWEN_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'

/** Default model id to seed the picker. */
export const QWEN_DEFAULT_MODEL_ID = 'qwen-plus'

export interface QwenProviderOptions {
  /** Override the Qwen (DashScope) HTTP endpoint. Defaults to `https://dashscope.aliyuncs.com/compatible-mode/v1`. */
  baseUrl?: string
  /** Override the default model id. Defaults to `qwen-plus`. */
  defaultModel?: string
  /** Override the model catalogue. Defaults to the built-in Qwen (DashScope) list. */
  models?: string[]
}

export function createQwenProvider(opts: QwenProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? QWEN_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? QWEN_DEFAULT_MODEL_ID
  const models = opts.models ?? ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long']

  return createCompatibleProvider({
    id: 'qwen',
    label: 'Qwen (DashScope)',
    models,
    defaultModel,
    keyPlaceholder: 'sk-…',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: false,
  })
}

const plugin = createQwenProvider()
export default plugin
