import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin from '../src/index'

/** Build a fake Reader whose `.read()` returns successive chunks. */
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

describe('@genoffice/provider-anthropic', () => {
  afterEach(() => vi.restoreAllMocks())

  it('declares anthropic id and Claude models', () => {
    expect(plugin.id).toBe('anthropic')
    expect(plugin.models).toContain('claude-sonnet-4-6')
    expect(plugin.defaultModel).toBe('claude-sonnet-4-6')
  })

  it('rejects non-Anthropic keys', () => {
    expect(() => plugin.validate({ apiKey: 'sk-other-1234' })).toThrow(/sk-ant-/)
    expect(() => plugin.validate({ apiKey: 'sk-ant-real-key' })).not.toThrow()
  })

  it('has chat and streamChat functions', () => {
    expect(typeof plugin.chat).toBe('function')
    expect(typeof plugin.streamChat).toBe('function')
  })

  it('chat() posts to /v1/messages with x-api-key + anthropic-version', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_1',
        content: [{ type: 'text', text: 'hello back' }],
        stop_reason: 'end_turn',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await plugin.chat(
      { settings: {} as never, system: 'be brief', user: 'hi' },
      { apiKey: 'sk-ant-test' },
    )
    expect(res.ok).toBe(true)
    expect(res.content).toBe('hello back')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.system).toBe('be brief')
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('chat() returns {ok:false} on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' }),
    )
    const res = await plugin.chat(
      { settings: {} as never, system: '', user: 'hi' },
      { apiKey: 'sk-ant-bad' },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/401/)
  })

  it('streamChat() yields deltas + done for SSE', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('')
    const enc = new TextEncoder().encode(sse)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => fakeReader([enc, undefined]) } }),
    )
    const out: string[] = []
    let doneCount = 0
    for await (const chunk of plugin.streamChat(
      { requestId: 'r1', settings: {} as never, system: '', messages: [{ role: 'user', text: 'hi' }] },
      { apiKey: 'sk-ant-test' },
    )) {
      if (chunk.type === 'delta') out.push(chunk.text ?? '')
      if (chunk.type === 'done') doneCount++
    }
    expect(out.join('')).toBe('Hello world')
    expect(doneCount).toBe(1)
  })

  it('streamChat() flattens assistant tool_calls + tool results', async () => {
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
      { apiKey: 'sk-ant-test' },
    )) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    // 3 messages: user + assistant(tool_use) + user(tool_result)
    expect(body.messages.length).toBe(3)
    expect(body.messages[1].content[0]).toMatchObject({ type: 'tool_use', name: 'fn' })
    expect(body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1' })
  })
})
