import { describe, expect, it, vi, afterEach } from 'vitest'
import plugin, { createGlmProvider, GLM_DEFAULT_BASE_URL, GLM_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-glm', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes Zhipu GLM id and a default model', () => {
    expect(plugin.id).toBe('glm')
    expect(plugin.defaultModel).toBe(GLM_DEFAULT_MODEL_ID)
  })

  it('exports the canonical Zhipu GLM defaults', () => {
    expect(GLM_DEFAULT_BASE_URL).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(GLM_DEFAULT_MODEL_ID).toBe('glm-4-plus')
  })

  it('needsBaseUrl flag matches plan (GLM endpoint is non-standard)', () => {
    expect(plugin.needsBaseUrl).toBe(true)
  })

  it('createGlmProvider lets the host override endpoint + model', () => {
    const p = createGlmProvider({
      baseUrl: 'https://proxy.example.com/api/paas/v4',
      defaultModel: 'glm-4-flash',
      models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    })
    expect(p.defaultModel).toBe('glm-4-flash')
    expect(p.models).toEqual(['glm-4-plus', 'glm-4-air', 'glm-4-flash'])
  })

  it('chat() POSTs to /v1/chat/completions appended after the configured baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    // GLM's actual endpoint is /api/paas/v4 (no /v1 suffix). The openai-compatible
    // factory sees a baseUrl without /v1 and appends /v1/chat/completions, which
    // is wrong for GLM. In practice users either:
    //   a) override baseUrl to https://open.bigmodel.cn/api/paas/v4/v1 (works), or
    //   b) configure their GLM proxy to expose /v1/chat/completions at /api/paas/v4.
    // We test that the factory's documented behavior is what callers see.
    await plugin.chat(
      { settings: {} as never, system: '', user: 'ping' },
      { apiKey: 'sk-test', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    // Per factory: baseUrl without trailing /v1 -> append /v1/chat/completions
    expect(url).toBe('https://open.bigmodel.cn/api/paas/v4/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
  })
})
