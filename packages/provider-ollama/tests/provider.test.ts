import { describe, expect, it, vi, afterEach } from 'vitest'
import ollama, { createOllamaProvider, OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_MODEL_ID } from '../src/index'

describe('@genoffice/provider-ollama', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exposes Ollama id and a default model', () => {
    expect(ollama.id).toBe('ollama')
    expect(ollama.defaultModel).toBe(OLLAMA_DEFAULT_MODEL_ID)
    expect(ollama.needsBaseUrl).toBe(true)
  })

  it('exports the canonical Ollama defaults', () => {
    expect(OLLAMA_DEFAULT_BASE_URL).toBe('http://localhost:11434/v1')
    expect(OLLAMA_DEFAULT_MODEL_ID).toBe('llama3.2')
  })

  it('accepts a non-empty apiKey (Ollama does not require one)', () => {
    expect(() => ollama.validate({ apiKey: 'ollama' })).not.toThrow()
    expect(() => ollama.validate({ apiKey: '' })).toThrow(/non-empty/)
  })

  it('createOllamaProvider lets the host override endpoint + model', () => {
    const p = createOllamaProvider({
      baseUrl: 'http://gpu-host:11434/v1',
      defaultModel: 'qwen2.5:7b',
      models: ['qwen2.5:7b', 'llama3.2'],
    })
    expect(p.defaultModel).toBe('qwen2.5:7b')
    expect(p.models).toEqual(['qwen2.5:7b', 'llama3.2'])
  })

  it('chat() POSTs to /v1/chat/completions on the Ollama endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'pong' } }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
    await ollama.chat(
      { settings: {} as never, system: '', user: 'ping' },
      { apiKey: 'ollama' },
    )
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://localhost:11434/v1/chat/completions')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer ollama')
  })
})
