import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin, { createQwenProvider, QWEN_DEFAULT_BASE_URL, QWEN_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-qwen', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes Qwen (DashScope) id and a default model', () => {
    expect(plugin.id).toBe('qwen')
    expect(plugin.defaultModel).toBe(QWEN_DEFAULT_MODEL_ID)
  })

  it('exports the canonical Qwen (DashScope) defaults', () => {
    expect(QWEN_DEFAULT_BASE_URL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(QWEN_DEFAULT_MODEL_ID).toBe('qwen-plus')
  })

  it('needsBaseUrl flag matches plan', () => {
    expect(plugin.needsBaseUrl).toBe(false)
  })

  it('createQwenProvider lets the host override endpoint + model', () => {
    const p = createQwenProvider({
      baseUrl: 'https://proxy.example.com/v1',
      defaultModel: 'qwen-long',
      models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'],
    })
    expect(p.defaultModel).toBe('qwen-long')
    expect(p.models).toEqual(['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'])
  })

  it('chat() POSTs to /v1/chat/completions on the Qwen (DashScope) endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await plugin.chat(
      { settings: {} as never, system: '', user: 'ping' },
      { apiKey: 'sk-test', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })
})
