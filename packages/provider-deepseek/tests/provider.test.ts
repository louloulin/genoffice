import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin, { createDeepSeekProvider, DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-deepseek', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes DeepSeek id and a default model', () => {
    expect(plugin.id).toBe('deepseek')
    expect(plugin.defaultModel).toBe(DEEPSEEK_DEFAULT_MODEL_ID)
  })

  it('exports the canonical DeepSeek defaults', () => {
    expect(DEEPSEEK_DEFAULT_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(DEEPSEEK_DEFAULT_MODEL_ID).toBe('deepseek-chat')
  })

  it('does not require a custom baseUrl', () => {
    expect(plugin.needsBaseUrl).toBe(false)
  })

  it('createDeepSeekProvider lets the host override endpoint + model', () => {
    const p = createDeepSeekProvider({
      baseUrl: 'https://proxy.example.com/v1',
      defaultModel: 'deepseek-reasoner',
      models: ['deepseek-chat', 'deepseek-reasoner'],
    })
    expect(p.defaultModel).toBe('deepseek-reasoner')
    expect(p.models).toEqual(['deepseek-chat', 'deepseek-reasoner'])
  })

  it('chat() POSTs to /v1/chat/completions on the DeepSeek endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await plugin.chat(
      { settings: {} as never, system: '', user: 'ping' },
      { apiKey: 'sk-test' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })
})
