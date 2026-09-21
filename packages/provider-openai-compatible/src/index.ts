/**
 * @genoffice/provider-openai-compatible — generic OpenAI-format provider plugin.
 *
 * This package exports a factory function (`createCompatibleProvider`) plus a
 * pre-built plugin factory for the most common case. The wire shape mirrors
 * the OpenAI `/v1/chat/completions` API exactly, so any vendor that serves
 * that endpoint works out of the box (Together, Fireworks, OpenRouter,
 * Groq, DeepSeek, Moonshot Kimi, GLM, Qwen DashScope, Doubao, vLLM, etc.).
 *
 * Hosts usually spread the returned plugin and override `id` / `label` /
 * `models` / `defaultModel` / `keyPlaceholder` for each vendor.
 */

import type {
  AiProviderPlugin,
  AiChatRequest,
  AiChatResponse,
  AiStreamChunk,
  AiStreamRequest,
  AgentMessage,
} from '@genoffice/ai-provider'

interface OpenAITool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
    }
  | { role: 'tool'; tool_call_id: string; content: string }

interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
}

interface OpenAIResponse {
  choices: Array<{ message?: { content?: string }; finish_reason?: string }>
  usage?: { prompt_tokens: number; completion_tokens: number }
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }
    finish_reason?: string | null
  }>
}

function toMessages(system: string, messages: AgentMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text })
    } else if (m.role === 'assistant') {
      const toolCalls = (m.toolCalls ?? []).map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }))
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      })
    } else {
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.output })
      }
    }
  }
  return out
}

export interface CompatibleProviderOptions {
  /** Pre-built default plugin metadata; spread + override per vendor. */
  id: string
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  /** Override the endpoint base URL. Default `https://api.openai.com/v1`. */
  defaultBaseUrl?: string
  /** Whether to require the user to supply a `baseUrl` (most vendors need it). */
  needsBaseUrl?: boolean
}

export function createCompatibleProvider(opts: CompatibleProviderOptions): AiProviderPlugin {
  const endpoint = (baseUrl: string) => {
    const trimmed = baseUrl.replace(/\/+$/, '')
    // Accept either `https://host/v1` or `https://host`
    return trimmed.endsWith('/v1') ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`
  }

  return {
    id: opts.id,
    label: opts.label,
    models: opts.models,
    defaultModel: opts.defaultModel,
    keyPlaceholder: opts.keyPlaceholder,
    needsBaseUrl: opts.needsBaseUrl,

    // Generic OpenAI-compat providers don't know the exact key shape;
    // accepting any non-empty string avoids false negatives against
    // vendors that use opaque tokens.
    validate({ apiKey }) {
      if (!apiKey || apiKey.trim().length < 4) {
        throw new Error('API key must be at least 4 characters')
      }
    },

    async chat(
      request: AiChatRequest,
      { apiKey, model, baseUrl },
    ): Promise<AiChatResponse> {
      const url = endpoint(baseUrl ?? opts.defaultBaseUrl ?? 'https://api.openai.com/v1')
      const body: OpenAIRequest = {
        model: model ?? opts.defaultModel,
        messages: toMessages(request.system, [{ role: 'user', text: request.user }]),
        max_tokens: 4096,
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        return { ok: false, error: `${opts.id} ${res.status}: ${text}` }
      }
      const json = (await res.json()) as OpenAIResponse
      const content = json.choices[0]?.message?.content ?? ''
      return { ok: true, content }
    },

    async *streamChat(
      request: AiStreamRequest,
      { apiKey, model, baseUrl },
    ): AsyncIterable<AiStreamChunk> {
      const url = endpoint(baseUrl ?? opts.defaultBaseUrl ?? 'https://api.openai.com/v1')
      const body: OpenAIRequest = {
        model: model ?? opts.defaultModel,
        messages: toMessages(request.system, request.messages),
        stream: true,
        max_tokens: request.maxTokens ?? 4096,
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const text = await res.text()
        yield { requestId: request.requestId, type: 'error', error: `${opts.id} ${res.status}: ${text}` }
        return
      }
      if (!res.body) {
        yield { requestId: request.requestId, type: 'error', error: 'no body' }
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value)
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data) continue
          if (data === '[DONE]') {
            yield { requestId: request.requestId, type: 'done' }
            return
          }
          try {
            const ev = JSON.parse(data) as OpenAIStreamChunk
            const delta = ev.choices?.[0]?.delta?.content
            if (delta) yield { requestId: request.requestId, type: 'delta', text: delta }
          } catch {
            /* ignore malformed SSE */
          }
        }
      }
      yield { requestId: request.requestId, type: 'done' }
    },
  }
}

/**
 * Pre-built plugin for vendors that don't need any host-side configuration
 * beyond supplying their own API key — i.e. any vendor exposing
 * `https://<host>/v1/chat/completions` with a Bearer token.
 */
const plugin: AiProviderPlugin = createCompatibleProvider({
  id: 'openai-compatible',
  label: 'OpenAI-compatible',
  models: [],
  defaultModel: '',
  keyPlaceholder: 'sk-…',
  needsBaseUrl: true,
})

export default plugin
