import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin, { createKimiProvider, KIMI_DEFAULT_BASE_URL, KIMI_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-kimi', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes Moonshot Kimi id and a default model', () => {
    expect(plugin.id).toBe('kimi')
    expect(plugin.defaultModel).toBe(KIMI_DEFAULT_MODEL_ID)
  })

  it('exports the canonical Moonshot Kimi defaults', () => {
    expect(KIMI_DEFAULT_BASE_URL).toBe('https://api.moonshot.cn/v1')
    expect(KIMI_DEFAULT_MODEL_ID).toBe('moonshot-v1-8k')
  })

  it('does not require a custom baseUrl', () => {
    expect(plugin.needsBaseUrl).toBe(false)
  })

  it('createKimiProvider lets the host override endpoint + model', () => {
    const p = createKimiProvider({
      baseUrl: 'https://proxy.example.com/v1',
      defaultModel: 'moonshot-v1-128k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    })
    expect(p.defaultModel).toBe('moonshot-v1-128k')
    expect(p.models).toEqual(['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'])
  })

  it('chat() POSTs to /v1/chat/completions on the Moonshot Kimi endpoint', async () => {
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
    expect(url).toBe('https://api.moonshot.cn/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })
})
