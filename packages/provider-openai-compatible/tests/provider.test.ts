import { describe, expect, it, vi, afterEach } from 'vitest'
import compatible, { createCompatibleProvider } from '../src/index'

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

describe('@genoffice/provider-openai-compatible', () => {
  afterEach(() => vi.restoreAllMocks())

  it('default plugin declares a baseUrl requirement', () => {
    expect(compatible.id).toBe('openai-compatible')
    expect(compatible.needsBaseUrl).toBe(true)
    expect(typeof compatible.chat).toBe('function')
    expect(typeof compatible.streamChat).toBe('function')
  })

  it('createCompatibleProvider returns a plugin with the supplied identity', () => {
    const plugin = createCompatibleProvider({
      id: 'together',
      label: 'Together.ai',
      models: ['m1'],
      defaultModel: 'm1',
      keyPlaceholder: 'tk-…',
      needsBaseUrl: true,
    })
    expect(plugin.id).toBe('together')
    expect(plugin.label).toBe('Together.ai')
    expect(plugin.defaultModel).toBe('m1')
  })

  it('rejects empty API keys', () => {
    expect(() => compatible.validate({ apiKey: '' })).toThrow(/at least 4 characters/)
    expect(() => compatible.validate({ apiKey: 'sk-real' })).not.toThrow()
  })

  it('chat() appends /v1 when baseUrl is bare host', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const plugin = createCompatibleProvider({
      id: 'groq',
      label: 'Groq',
      models: ['llama'],
      defaultModel: 'llama',
      keyPlaceholder: 'gsk_…',
      needsBaseUrl: true,
    })
    await plugin.chat({ settings: {} as never, system: '', user: 'ping' }, {
      apiKey: 'gsk-abc',
      baseUrl: 'https://api.groq.com/openai',
    })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions')
  })

  it('chat() preserves /v1 when baseUrl already ends with it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const plugin = createCompatibleProvider({
      id: 'together',
      label: 'Together',
      models: ['m1'],
      defaultModel: 'm1',
      keyPlaceholder: 'tk-…',
    })
    await plugin.chat({ settings: {} as never, system: '', user: 'ping' }, {
      apiKey: 'tk-abc',
      baseUrl: 'https://api.together.xyz/v1/',
    })
    const [url] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.together.xyz/v1/chat/completions')
  })

  it('streamChat() yields deltas for SSE', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ].join('')
    const enc = new TextEncoder().encode(sse)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => fakeReader([enc, undefined]) } }),
    )
    const plugin = createCompatibleProvider({
      id: 'fireworks',
      label: 'Fireworks',
      models: ['m1'],
      defaultModel: 'm1',
      keyPlaceholder: 'fw-…',
    })
    const out: string[] = []
    let doneCount = 0
    for await (const chunk of plugin.streamChat(
      { requestId: 'r1', settings: {} as never, system: '', messages: [{ role: 'user', text: 'hi' }] },
      { apiKey: 'fw-abc', baseUrl: 'https://api.fireworks.ai/inference/v1' },
    )) {
      if (chunk.type === 'delta') out.push(chunk.text ?? '')
      if (chunk.type === 'done') doneCount++
    }
    expect(out.join('')).toBe('Hi')
    expect(doneCount).toBe(1)
  })
})
