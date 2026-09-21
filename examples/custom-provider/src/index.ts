/**
 * Worked example of a third-party LLM provider plugin.
 *
 * Implements the `AiProviderPlugin` contract from `@genoffice/ai-provider`.
 * The two methods every plugin must ship are:
 *
 *   - `chat(request, config)` — one-shot completion. `request.user` is a
 *     single string and `request.system` is the system prompt.
 *   - `streamChat(request, config)` — streaming completion. `request.messages`
 *     is an `AgentMessage[]` (multi-turn) and the function is an async
 *     generator that yields `AiStreamChunk` values.
 *
 * The wire format here (`POST /v1/chat` returns `{content}`, `/v1/chat/stream`
 * emits SSE `data: {delta}` lines) is a placeholder — replace both with
 * whatever your real provider exposes.
 *
 * Build & install:
 *
 *   pnpm install
 *   pnpm run build
 *
 * Drop the resulting `dist/` into the web-server's `genoffice.providers.json`:
 *
 *   { "providers": [{ "name": "@genoffice/provider-my-provider" }] }
 *
 * The marketplace loader picks it up at boot, registers it into
 * `getDefaultProviderRegistry()`, and `chatForProvider('my-provider', ...)` /
 * `streamForProvider('my-provider', ...)` route through it.
 */

import type {
  AiProviderPlugin,
  AiStreamRequest,
  AgentMessage,
} from '@genoffice/ai-provider'

interface ChatRequest {
  system: string
  user: string
}

interface StreamDeltaEvent {
  delta?: string
}

const ENDPOINT = 'https://api.my-provider.example'

const plugin: AiProviderPlugin = {
  id: 'my-provider',
  label: 'My Provider',
  models: ['my-mini', 'my-pro'],
  defaultModel: 'my-mini',
  keyPlaceholder: 'mp-…',

  /**
   * Optional synchronous API key validator. Throw to reject before any HTTP
   * call is made. Receivers surface the message back to the user in the
   * settings UI.
   */
  validate({ apiKey }) {
    if (!apiKey.startsWith('mp-')) {
      throw new Error('API key must start with "mp-"')
    }
  },

  /**
   * One-shot chat completion. The provider receives `{ settings, system, user }`
   * in `request`. `settings` carries `apiKey` / `baseUrl` / `model` (we also
   * pass them in the second argument for plugins that prefer that shape).
   *
   * Return shape: `{ ok: true, content }` on success, `{ ok: false, error }`
   * on failure. The renderer maps `ok: false` to a localized error toast.
   */
  async chat(request: ChatRequest, { apiKey, model }): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    const res = await fetch(`${ENDPOINT}/v1/chat`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? plugin.defaultModel,
        system: request.system,
        user: request.user,
      }),
    })
    const json = (await res.json()) as { content?: string; error?: string }
    if (json.error) return { ok: false, error: json.error }
    return { ok: true, content: json.content ?? '' }
  },

  /**
   * Streaming chat completion. `request.messages` is the full multi-turn
   * history (most recent last) including tool calls and tool results. Most
   * providers need this flattened into their own wire format — see
   * `packages/provider-anthropic/src/index.ts` for a real reference impl.
   */
  async *streamChat(request: AiStreamRequest, { apiKey, model }): AsyncIterable<{ requestId: string; type: 'delta' | 'done' | 'error'; text?: string; error?: string }> {
    // Translate GenOffice AgentMessage[] into whatever your provider expects.
    const messages = request.messages.map((m: AgentMessage) => {
      // GenOffice AgentMessage has three role variants:
      //   - 'user' / 'assistant' carry .text (and possibly .images / .toolCalls)
      //   - 'tool' carries .results (no text on the wrapper)
      if (m.role === 'tool') {
        return { role: 'tool', results: m.results }
      }
      return { role: m.role, content: m.text }
    })
    const res = await fetch(`${ENDPOINT}/v1/chat/stream`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: model ?? plugin.defaultModel,
        system: request.system,
        messages,
        stream: true,
      }),
    })
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
          const ev = JSON.parse(data) as StreamDeltaEvent
          if (ev.delta) yield { requestId: request.requestId, type: 'delta', text: ev.delta }
        } catch {
          /* ignore malformed SSE */
        }
      }
    }
    yield { requestId: request.requestId, type: 'done' }
  },
}

export default plugin
