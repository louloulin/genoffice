/**
 * @genoffice/provider-glm — Zhipu GLM provider plugin for GenOffice.
 *
 * Talks to Zhipu GLM via its OpenAI-compatible surface. Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 *
 * Endpoint: `https://open.bigmodel.cn/api/paas/v4`. needsBaseUrl=True.
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default Zhipu GLM OpenAI-compat endpoint. */
export const GLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

/** Default model id to seed the picker. */
export const GLM_DEFAULT_MODEL_ID = 'glm-4-plus'

export interface GlmProviderOptions {
  /** Override the Zhipu GLM HTTP endpoint. Defaults to `https://open.bigmodel.cn/api/paas/v4`. */
  baseUrl?: string
  /** Override the default model id. Defaults to `glm-4-plus`. */
  defaultModel?: string
  /** Override the model catalogue. Defaults to the built-in Zhipu GLM list. */
  models?: string[]
}

export function createGlmProvider(opts: GlmProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? GLM_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? GLM_DEFAULT_MODEL_ID
  const models = opts.models ?? ['glm-4-plus', 'glm-4-air', 'glm-4-flash']

  return createCompatibleProvider({
    id: 'glm',
    label: 'Zhipu GLM',
    models,
    defaultModel,
    keyPlaceholder: '…',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: true,
  })
}

const plugin = createGlmProvider()
export default plugin
