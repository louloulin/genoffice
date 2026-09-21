/**
 * @genoffice/provider-doubao — ByteDance Doubao provider plugin for GenOffice.
 *
 * Talks to Doubao via the Volcano Engine Ark API, which exposes an
 * OpenAI-compatible surface. Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 *
 * Endpoint: `https://ark.cn-beijing.volces.com/api/v3` (non-standard
 * path — no `/v1` suffix). needsBaseUrl: true.
 */

import { createCompatibleProvider, type CompatibleProviderOptions } from '@genoffice/provider-openai-compatible'

/** Default Doubao Ark endpoint. */
export const DOUBAO_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3'

/** Default model id to seed the picker. */
export const DOUBAO_DEFAULT_MODEL_ID = 'doubao-pro-32k'

export interface DoubaoProviderOptions {
  /** Override the Doubao HTTP endpoint. Defaults to the Ark `api/v3` URL. */
  baseUrl?: string
  /** Override the default model id. */
  defaultModel?: string
  /** Override the model catalogue. */
  models?: string[]
}

export function createDoubaoProvider(opts: DoubaoProviderOptions = {}): ReturnType<typeof createCompatibleProvider> {
  const baseUrl = opts.baseUrl ?? DOUBAO_DEFAULT_BASE_URL
  const defaultModel = opts.defaultModel ?? DOUBAO_DEFAULT_MODEL_ID
  const models = opts.models ?? ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k']

  return createCompatibleProvider({
    id: 'doubao',
    label: 'ByteDance Doubao',
    models,
    defaultModel,
    keyPlaceholder: '…',
    defaultBaseUrl: baseUrl,
    needsBaseUrl: true,
  })
}

const plugin = createDoubaoProvider()
export default plugin
