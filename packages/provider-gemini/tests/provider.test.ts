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

describe('@genoffice/provider-gemini', () => {
  afterEach(() => vi.restoreAllMocks())

  it('declares gemini id and Gemini models', () => {
    expect(plugin.id).toBe('gemini')
    expect(plugin.models).toContain('gemini-2.0-flash')
    expect(plugin.defaultModel).toBe('gemini-2.0-flash')
  })

  it('rejects non-Google keys', () => {
    expect(() => plugin.validate({ apiKey: 'other-1234' })).toThrow(/AIza/)
    expect(() => plugin.validate({ apiKey: 'AIza-real-key' })).not.toThrow()
  })

  it('has chat and streamChat functions', () => {
    expect(typeof plugin.chat).toBe('function')
    expect(typeof plugin.streamChat).toBe('function')
  })

  it('chat() uses ?key= query param and contents[] body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'pong' }], role: 'model' }, finishReason: 'STOP' }],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const res = await plugin.chat(
      { settings: {} as never, system: 'be brief', user: 'ping' },
      { apiKey: 'AIza-test' },
    )
    expect(res.ok).toBe(true)
    expect(res.content).toBe('pong')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('?key=AIza-test')
    expect(url).toContain(':generateContent')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.systemInstruction.parts[0].text).toBe('be brief')
    expect(body.contents[0]).toEqual({ role: 'user', parts: [{ text: 'ping' }] })
  })

  it('chat() returns {ok:false} on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' }),
    )
    const res = await plugin.chat(
      { settings: {} as never, system: '', user: 'hi' },
      { apiKey: 'AIza-bad' },
    )
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/403/)
  })

  it('streamChat() parses newline-delimited JSON chunks', async () => {
    const sse = [
      JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hi' }] } }] }),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: ' gemini' }] } }] }),
      '',
    ].join('\n')
    const enc = new TextEncoder().encode(sse)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, body: { getReader: () => fakeReader([enc, undefined]) } }),
    )
    const out: string[] = []
    let doneCount = 0
    for await (const chunk of plugin.streamChat(
      { requestId: 'r4', settings: {} as never, system: '', messages: [{ role: 'user', text: 'hi' }] },
      { apiKey: 'AIza-test' },
    )) {
      if (chunk.type === 'delta') out.push(chunk.text ?? '')
      if (chunk.type === 'done') doneCount++
    }
    expect(out.join('')).toBe('Hi gemini')
    expect(doneCount).toBe(1)
  })

  it('streamChat() addresses tool results by tool name', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => fakeReader([new TextEncoder().encode(''), undefined]) },
    })
    vi.stubGlobal('fetch', fetchMock)
    const messages = [
      { role: 'user' as const, text: 'search' },
      {
        role: 'assistant' as const,
        text: '',
        toolCalls: [{ id: 'c1', name: 'lookup', input: { q: 'AI' } }],
      },
      {
        role: 'tool' as const,
        results: [{ id: 'c1', name: 'lookup', output: 'ok' }],
      },
    ]
    for await (const _ of plugin.streamChat(
      { requestId: 'r5', settings: {} as never, system: '', messages },
      { apiKey: 'AIza-test' },
    )) {
      // drain
    }
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.contents[2].role).toBe('user')
    expect(body.contents[2].parts[0].functionResponse.name).toBe('lookup')
  })
})
