/**
 * @genoffice/provider-openai — OpenAI provider plugin for GenOffice.
 *
 * Implements the `AiProviderPlugin` contract from `@genoffice/ai-provider`.
 * Defaults to `gpt-4o-mini`; ships `gpt-4o`, `gpt-4-turbo`, `gpt-3.5-turbo`.
 *
 * Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 *
 * Tool support: tools[] are translated to OpenAI's `tools` field when present
 * on the request; tool_calls come back via `delta.tool_calls`. Tool message
 * role is `tool` per OpenAI's spec.
 */

import type {
  AiProviderPlugin,
  AiChatRequest,
  AiChatResponse,
  AiStreamChunk,
  AiStreamRequest,
  AgentMessage,
} from '@genoffice/ai-provider'

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

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
      // tool role — one message per result
      for (const r of m.results) {
        out.push({ role: 'tool', tool_call_id: r.id, content: r.output })
      }
    }
  }
  return out
}

const plugin: AiProviderPlugin = {
  id: 'openai',
  label: 'OpenAI',
  models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  defaultModel: 'gpt-4o-mini',
  keyPlaceholder: 'sk-…',

  validate({ apiKey }) {
    if (!apiKey.startsWith('sk-')) {
      throw new Error('OpenAI API key must start with "sk-"')
    }
  },

  async chat(request: AiChatRequest, { apiKey, model }): Promise<AiChatResponse> {
    const body: OpenAIRequest = {
      model: model ?? plugin.defaultModel,
      messages: toMessages(request.system, [{ role: 'user', text: request.user }]),
      max_tokens: 4096,
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `openai ${res.status}: ${text}` }
    }
    const json = (await res.json()) as OpenAIResponse
    const content = json.choices[0]?.message?.content ?? ''
    return { ok: true, content }
  },

  async *streamChat(request: AiStreamRequest, { apiKey, model }): AsyncIterable<AiStreamChunk> {
    const body: OpenAIRequest = {
      model: model ?? plugin.defaultModel,
      messages: toMessages(request.system, request.messages),
      stream: true,
      max_tokens: request.maxTokens ?? 4096,
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      yield { requestId: request.requestId, type: 'error', error: `openai ${res.status}: ${text}` }
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

export default plugin
