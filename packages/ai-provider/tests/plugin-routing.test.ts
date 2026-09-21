import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  chatForProvider,
  streamForProvider,
  getDefaultProviderRegistry,
  resetDefaultProviderRegistry,
  type AiProviderPlugin,
  type AiStreamRequest,
  type AiChatRequest,
} from '../src/index'

const fakePlugin: AiProviderPlugin = {
  id: 'fake-plugin',
  label: 'Fake Plugin',
  models: ['fake-v1'],
  defaultModel: 'fake-v1',
  keyPlaceholder: 'fk-…',
  async chat(_req: AiChatRequest, _cfg) {
    return { ok: true as const, content: 'plugin chat ok' }
  },
  async *streamChat(_req: AiStreamRequest, _cfg) {
    yield { requestId: 'r1', type: 'delta' as const, text: 'hello ' }
    yield { requestId: 'r1', type: 'delta' as const, text: 'world' }
    yield { requestId: 'r1', type: 'done' as const, stopReason: 'end_turn' }
  },
}

afterEach(() => {
  resetDefaultProviderRegistry()
})

describe('plugin-first routing in chat/stream helpers', () => {
  it('chatForProvider uses the registered plugin when one matches', async () => {
    getDefaultProviderRegistry().register(fakePlugin)
    const result = await chatForProvider('fake-plugin', { apiKey: 'k', model: 'fake-v1' }, 'sys', 'hi')
    expect(result).toEqual({ ok: true, content: 'plugin chat ok' })
  })

  it('chatForProvider falls back to legacy adapter when no plugin is registered', async () => {
    // Without plugin registered, 'anthropic' id should fall through to legacy
    // getProviderAdapter (which will throw because no api key configured for live call)
    const result = await chatForProvider('anthropic', { apiKey: 'k', model: 'm' }, 'sys', 'hi')
    expect(result.ok).toBe(false)
  })

  it('streamForProvider uses the registered plugin when one matches', async () => {
    getDefaultProviderRegistry().register(fakePlugin)
    const deltas: string[] = []
    await streamForProvider(
      'fake-plugin',
      { apiKey: 'k', model: 'fake-v1' },
      'sys',
      [{ role: 'user', text: 'hi' }],
      [],
      4096,
      {
        onDelta: (t) => deltas.push(t),
        onToolCall: () => {},
        signal: new AbortController().signal,
        sessionId: 'r1',
      },
    )
    expect(deltas.join('')).toBe('hello world')
  })

  it('plugin streamChat error chunk surfaces as thrown error', async () => {
    const errorPlugin: AiProviderPlugin = {
      id: 'fake-err',
      label: 'Fake Err',
      models: ['fake-v1'],
      defaultModel: 'fake-v1',
      keyPlaceholder: 'fk-…',
      chat: async () => ({ ok: false as const, error: 'should not call' }),
      async *streamChat() {
        yield { requestId: 'r1', type: 'error' as const, error: 'boom' }
      },
    }
    getDefaultProviderRegistry().register(errorPlugin)
    await expect(
      streamForProvider(
        'fake-err',
        { apiKey: 'k', model: 'fake-v1' },
        'sys',
        [{ role: 'user', text: 'hi' }],
        [],
        4096,
        { onDelta: () => {}, onToolCall: () => {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow('boom')
  })

  it('plugin streamChat tool-call chunk is forwarded', async () => {
    const toolPlugin: AiProviderPlugin = {
      id: 'fake-tool',
      label: 'Fake Tool',
      models: ['fake-v1'],
      defaultModel: 'fake-v1',
      keyPlaceholder: 'fk-…',
      chat: async () => ({ ok: true as const, content: '' }),
      async *streamChat() {
        yield { requestId: 'r1', type: 'tool-call' as const, toolCall: { id: 'c1', name: 'lookup', input: { q: 'x' } } }
        yield { requestId: 'r1', type: 'done' as const }
      },
    }
    getDefaultProviderRegistry().register(toolPlugin)
    const calls: unknown[] = []
    await streamForProvider(
      'fake-tool',
      { apiKey: 'k', model: 'fake-v1' },
      'sys',
      [{ role: 'user', text: 'hi' }],
      [],
      4096,
      {
        onDelta: () => {},
        onToolCall: (c) => calls.push(c),
        signal: new AbortController().signal,
      },
    )
    expect(calls).toHaveLength(1)
  })

  it('resetDefaultProviderRegistry clears the registry between tests', () => {
    getDefaultProviderRegistry().register(fakePlugin)
    expect(getDefaultProviderRegistry().size()).toBe(1)
    resetDefaultProviderRegistry()
    expect(getDefaultProviderRegistry().size()).toBe(0)
  })
})
