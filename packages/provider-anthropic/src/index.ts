/**
 * @genoffice/provider-anthropic — Anthropic (Claude) provider plugin for GenOffice.
 *
 * Implements the `AiProviderPlugin` contract from `@genoffice/ai-provider`.
 * Three models ship by default: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5.
 * The provider talks to Anthropic's `messages` API directly using `fetch`.
 *
 * Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 */

import type {
  AiProviderPlugin,
  AiChatRequest,
  AiChatResponse,
  AiStreamChunk,
  AiStreamRequest,
  AgentMessage,
} from '@genoffice/ai-provider'

const ENDPOINT = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  source?: { type: 'base64'; media_type: string; data: string }
  tool_use_id?: string
  content?: string
  is_error?: boolean
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

interface AnthropicRequest {
  model: string
  max_tokens: number
  system?: string
  messages: AnthropicMessage[]
  stream?: boolean
  temperature?: number
}

interface AnthropicResponse {
  id: string
  content: Array<{ type: 'text' | 'tool_use'; text?: string; [k: string]: unknown }>
  stop_reason: string
  usage?: { input_tokens: number; output_tokens: number }
}

interface AnthropicStreamEvent {
  type:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop'
    | 'ping'
    | 'error'
  delta?: { type?: string; text?: string; stop_reason?: string }
  error?: { type: string; message: string }
  message?: { id: string; usage?: { input_tokens: number; output_tokens: number } }
}

function toAnthropicMessages(messages: AgentMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (!m.images?.length) {
        out.push({ role: 'user', content: m.text })
      } else {
        out.push({
          role: 'user',
          content: [
            ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
            ...m.images.map((img) => ({
              type: 'image' as const,
              source: { type: 'base64' as const, media_type: img.mime, data: img.base64 },
            })),
          ],
        })
      }
    } else if (m.role === 'assistant') {
      const content: AnthropicContentBlock[] = []
      if (m.text) content.push({ type: 'text', text: m.text })
      for (const call of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      // Anthropic rejects empty content arrays
      if (content.length === 0) content.push({ type: 'text', text: '(no content)' })
      out.push({ role: 'assistant', content })
    } else {
      // tool results — Anthropic uses user-role tool_result blocks
      out.push({
        role: 'user',
        content: m.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.output,
          ...(r.isError ? { is_error: true } : {}),
        })),
      })
    }
  }
  return out
}

const plugin: AiProviderPlugin = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  defaultModel: 'claude-sonnet-4-6',
  keyPlaceholder: 'sk-ant-…',

  validate({ apiKey }) {
    if (!apiKey.startsWith('sk-ant-')) {
      throw new Error('Anthropic API key must start with "sk-ant-"')
    }
  },

  async chat(request: AiChatRequest, { apiKey, model }): Promise<AiChatResponse> {
    const body: AnthropicRequest = {
      model: model ?? plugin.defaultModel,
      max_tokens: 4096,
      messages: [{ role: 'user', content: request.user }],
      ...(request.system ? { system: request.system } : {}),
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `anthropic ${res.status}: ${text}` }
    }
    const json = (await res.json()) as AnthropicResponse
    const text = json.content.find((b) => b.type === 'text')?.text ?? ''
    return { ok: true, content: text }
  },

  async *streamChat(request: AiStreamRequest, { apiKey, model }): AsyncIterable<AiStreamChunk> {
    const body: AnthropicRequest = {
      model: model ?? plugin.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: toAnthropicMessages(request.messages),
      stream: true,
      ...(request.system ? { system: request.system } : {}),
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      yield { requestId: request.requestId, type: 'error', error: `anthropic ${res.status}: ${text}` }
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
        if (!data || data === '[DONE]') continue
        try {
          const ev = JSON.parse(data) as AnthropicStreamEvent
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            yield { requestId: request.requestId, type: 'delta', text: ev.delta.text }
          } else if (ev.type === 'message_stop') {
            yield { requestId: request.requestId, type: 'done' }
            return
          } else if (ev.type === 'error' && ev.error) {
            yield { requestId: request.requestId, type: 'error', error: ev.error.message }
            return
          }
        } catch {
          /* ignore malformed SSE */
        }
      }
    }
    yield { requestId: request.requestId, type: 'done' }
  },
}

export default plugin
