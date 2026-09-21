import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin, { createDoubaoProvider, DOUBAO_DEFAULT_BASE_URL, DOUBAO_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-doubao', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes Doubao id and a default model', () => {
    expect(plugin.id).toBe('doubao')
    expect(plugin.defaultModel).toBe(DOUBAO_DEFAULT_MODEL_ID)
  })

  it('exports the canonical Doubao defaults', () => {
    expect(DOUBAO_DEFAULT_BASE_URL).toBe('https://ark.cn-beijing.volces.com/api/v3')
    expect(DOUBAO_DEFAULT_MODEL_ID).toBe('doubao-pro-32k')
  })

  it('needsBaseUrl flag matches plan (Doubao endpoint is non-standard)', () => {
    expect(plugin.needsBaseUrl).toBe(true)
  })

  it('createDoubaoProvider lets the host override endpoint + model', () => {
    const p = createDoubaoProvider({
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      defaultModel: 'doubao-pro-128k',
      models: ['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'],
    })
    expect(p.defaultModel).toBe('doubao-pro-128k')
    expect(p.models).toEqual(['doubao-pro-32k', 'doubao-pro-128k', 'doubao-lite-32k'])
  })

  it('chat() POSTs to /v1/chat/completions appended after the configured baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await plugin.chat(
      { settings: {} as never, system: '', user: 'ping' },
      { apiKey: 'sk-test', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })
})
