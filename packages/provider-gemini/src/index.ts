/**
 * @genoffice/provider-gemini — Google Gemini provider plugin for GenOffice.
 *
 * Implements the `AiProviderPlugin` contract from `@genoffice/ai-provider`.
 * Defaults to `gemini-2.0-flash`; ships `gemini-2.5-pro`, `gemini-2.0-flash`,
 * `gemini-1.5-pro`, `gemini-1.5-flash`.
 *
 * Wire compatibility:
 *   - chat()       uses { settings, system, user } (single-shot)
 *   - streamChat() uses { settings, system, messages } (multi-turn AgentMessage[])
 *
 * Gemini wire quirks handled here:
 *   - The API key is passed as a `?key=` query param (not Authorization header)
 *   - System prompts go into a separate `systemInstruction` field, not as a
 *     message turn
 *   - Tool results are addressed by tool *name* (not id), grouped into a
 *     single function-response part per turn
 *   - Stream chunks arrive as a top-level JSON array OR newline-delimited
 *     JSON depending on the endpoint variant; we accept both
 */

import type {
  AiProviderPlugin,
  AiChatRequest,
  AiChatResponse,
  AiStreamChunk,
  AiStreamRequest,
  AgentMessage,
} from '@genoffice/ai-provider'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiPartText {
  text: string
}
interface GeminiPartFunctionCall {
  functionCall: { name: string; args: Record<string, unknown> }
}
interface GeminiPartFunctionResponse {
  functionResponse: { name: string; response: { result: string } }
}
type GeminiPart = GeminiPartText | GeminiPartFunctionCall | GeminiPartFunctionResponse

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { role: 'user'; parts: Array<{ text: string }> }
  generationConfig?: { maxOutputTokens?: number; temperature?: number }
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: string }
    finishReason: string
  }>
}

interface GeminiStreamChunk {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
}

function makeEndpoint(model: string, action: 'generateContent' | 'streamGenerateContent'): string {
  return `${BASE}/models/${model}:${action}?key=KEY_PLACEHOLDER`
}

function toContents(system: string, messages: AgentMessage[]): { systemInstruction?: GeminiRequest['systemInstruction']; contents: GeminiContent[] } {
  const systemParts: string[] = system ? [system] : []
  const contents: GeminiContent[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts: GeminiPart[] = m.text ? [{ text: m.text }] : []
      contents.push({ role: 'user', parts })
    } else if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (m.text) parts.push({ text: m.text })
      for (const call of m.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.name, args: call.input } })
      }
      if (parts.length === 0) parts.push({ text: '(no content)' })
      contents.push({ role: 'model', parts })
    } else {
      // tool results — Gemini uses functionResponse parts on a user-role turn
      const parts: GeminiPart[] = m.results.map((r) => ({
        functionResponse: { name: r.name, response: { result: r.output } },
      }))
      contents.push({ role: 'user', parts })
    }
  }
  const systemInstruction =
    systemParts.length > 0
      ? { role: 'user' as const, parts: [{ text: systemParts.join('\n\n') }] }
      : undefined
  return { systemInstruction, contents }
}

const plugin: AiProviderPlugin = {
  id: 'gemini',
  label: 'Google Gemini',
  models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  defaultModel: 'gemini-2.0-flash',
  keyPlaceholder: 'AIza…',

  validate({ apiKey }) {
    if (!apiKey.startsWith('AIza')) {
      throw new Error('Google AI API key must start with "AIza"')
    }
  },

  async chat(request: AiChatRequest, { apiKey, model }): Promise<AiChatResponse> {
    const url = makeEndpoint(model ?? plugin.defaultModel, 'generateContent').replace(
      'KEY_PLACEHOLDER',
      encodeURIComponent(apiKey),
    )
    const { systemInstruction, contents } = toContents(request.system, [
      { role: 'user', text: request.user },
    ])
    const body: GeminiRequest = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: { maxOutputTokens: 4096 },
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      return { ok: false, error: `gemini ${res.status}: ${text}` }
    }
    const json = (await res.json()) as GeminiResponse
    const text = json.candidates[0]?.content.parts
      .filter((p): p is GeminiPartText => 'text' in p)
      .map((p) => p.text)
      .join('') ?? ''
    return { ok: true, content: text }
  },

  async *streamChat(request: AiStreamRequest, { apiKey, model }): AsyncIterable<AiStreamChunk> {
    const url = makeEndpoint(model ?? plugin.defaultModel, 'streamGenerateContent').replace(
      'KEY_PLACEHOLDER',
      encodeURIComponent(apiKey),
    )
    const { systemInstruction, contents } = toContents(request.system, request.messages)
    const body: GeminiRequest = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      generationConfig: { maxOutputTokens: request.maxTokens ?? 4096 },
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text()
      yield { requestId: request.requestId, type: 'error', error: `gemini ${res.status}: ${text}` }
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
      // Gemini streams JSON objects separated by commas inside a top-level
      // array, OR newline-delimited JSON. Accept either.
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim().replace(/^\[|\]$/g, '').trim()
        if (!trimmed) continue
        // tolerate leading comma artifacts
        const cleaned = trimmed.replace(/^,/, '').trim()
        if (!cleaned) continue
        try {
          const ev = JSON.parse(cleaned) as GeminiStreamChunk
          const text =
            ev.candidates?.[0]?.content?.parts
              ?.filter((p): p is GeminiPartText => 'text' in p)
              .map((p) => p.text ?? '')
              .join('') ?? ''
          if (text) yield { requestId: request.requestId, type: 'delta', text }
        } catch {
          /* partial chunk — keep accumulating */
        }
      }
    }
    yield { requestId: request.requestId, type: 'done' }
  },
}

export default plugin
