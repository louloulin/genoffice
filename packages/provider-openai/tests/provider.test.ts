import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin from '../src/index'

function fakeReader(chunks: (Uint8Array | undefined)[]) {
  let i = 0
  return {
    async read(): Promise<{ value: Uint8Array | undefined; done: boolean }> {
      if (i >= chunks.length) return { value: undefined, done: true }
      const value = chunks[i++]
      return { value, done: false }
    },
  }
}

describe('@genoffice/provider-openai', () => {
  afterEach(() => vi.restoreAllMocks())

  it('declares openai id and GPT models', () => {
    expect(plugin.id).toBe('openai')
    expect(plugin.models).toContain('gpt-4o-mini')
    expect(plugin.defaultModel).toBe('gpt-4o-mini')
  })

  it('rejects non-OpenAI keys', () => {
    expect(() => plugin.validate({ apiKey: 'other-1234' })).toThrow(/sk-/)
    expect(() => plugin.validate({ apiKey: 'sk-real-key' })).not.toThrow()
  })

  it('has chat and streamChat functions', () => {
    expect(typeof plugin.chat).toBe('function')
    expect(typeof plugin.streamChat).toBe('function')
  })

  it('chat() posts Bearer auth + JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await plugin.chat(
      { settings: {} as never, system: 'be brief', user: 'ping' },
      { apiKey: 'sk-test' },
    )
    expect(res.ok).toBe(true)
    expect(res.content).toBe('pong')
    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be brief' })
    expect(body.messages[1]).toEqual({ role: 'user', content: 'ping' })
  })

  it('chat() returns {ok:false} on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'rate-limited' }),
    )
    const res = await plugin.chat(
      { settings: {} as never, system: '', user: 'hi' },
      { apiKey: 'sk-bad' },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/429/)
  })

  it('streamChat() yields deltas for SSE chunks', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const enc = new TextEncoder().encode(sse)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => fakeReader([enc, undefined]) } }),
    )
    const out: string[] = []
    let doneCount = 0
    for await (const chunk of plugin.streamChat(
      { requestId: 'r2', settings: {} as never, system: '', messages: [{ role: 'user', text: 'hi' }] },
      { apiKey: 'sk-test' },
    )) {
      if (chunk.type === 'delta') out.push(chunk.text ?? '')
      if (chunk.type === 'done') doneCount++
    }
    expect(out.join('')).toBe('Hi there')
    expect(doneCount).toBe(1)
  })

  it('streamChat() flattens tool results to OpenAI tool messages', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => fakeReader([new TextEncoder().encode(''), undefined]) },
    })
    vi.stubGlobal('fetch', fetchMock)
    const messages = [
      { role: 'user' as const, text: 'do thing' },
      { role: 'assistant' as const, text: '', toolCalls: [{ id: 'c1', name: 'fn', input: { x: 1 } }] },
      { role: 'tool' as const, results: [{ id: 'c1', name: 'fn', output: '{"ok":true}' }] },
    ]
    for await (const _ of plugin.streamChat(
      { requestId: 'r3', settings: {} as never, system: '', messages },
      { apiKey: 'sk-test' },
    )) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    // 3 messages: user + assistant(tool_calls) + tool (system was empty)
    expect(body.messages.length).toBe(3)
    expect(body.messages[1].role).toBe("assistant")
    expect(body.messages[1].tool_calls[0]).toMatchObject({ id: "c1", function: { name: "fn" } })
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' })
  })
})
