import { describe, expect, it } from 'vitest'
import {
  createProviderRegistry,
  createMediaRegistry,
  createSearchRegistry,
  type AiProviderPlugin,
  type AiMediaPlugin,
  type AiSearchPlugin,
} from '../src/provider-plugin'

const fakeChatPlugin: AiProviderPlugin = {
  id: 'fake-chat',
  label: 'Fake Chat',
  models: ['fake-mini', 'fake-pro'],
  defaultModel: 'fake-mini',
  keyPlaceholder: 'fk-…',
  chat: async () => ({ ok: true, content: '' }),
  streamChat: async function* () {
    yield { requestId: 'r1', type: 'ping' as const }
    yield { requestId: 'r1', type: 'done' as const }
  },
}

const fakeMediaPlugin: AiMediaPlugin = {
  id: 'fake-media',
  label: 'Fake Media',
  keyPlaceholder: 'fm-…',
  defaultBaseUrl: 'https://api.fake.example',
  imageModels: ['fake-img'],
  defaultImageModel: 'fake-img',
  analysisModels: ['fake-anl'],
  defaultAnalysisModel: 'fake-anl',
  videoAnalysis: false,
  generateImage: async () => ({ url: 'https://example.com/img.png' }),
}

const fakeSearchPlugin: AiSearchPlugin = {
  id: 'fake-search',
  label: 'Fake Search',
  search: async () => ({ results: [] }),
}

describe('createProviderRegistry', () => {
  it('registers and lists plugins', () => {
    const reg = createProviderRegistry()
    reg.register(fakeChatPlugin)
    expect(reg.list()).toEqual(['fake-chat'])
    expect(reg.get('fake-chat')).toBe(fakeChatPlugin)
    expect(reg.size()).toBe(1)
  })

  it('rejects a plugin without an id', () => {
    const reg = createProviderRegistry()
    expect(() => reg.register({ ...fakeChatPlugin, id: '' })).toThrow(/id required/)
  })

  it('rejects a plugin without chat/streamChat', () => {
    const reg = createProviderRegistry()
    expect(() => reg.register({ ...fakeChatPlugin, chat: undefined as never })).toThrow(/chat/)
  })

  it('unregisters by id', () => {
    const reg = createProviderRegistry()
    reg.register(fakeChatPlugin)
    expect(reg.unregister('fake-chat')).toBe(true)
    expect(reg.unregister('fake-chat')).toBe(false)
  })

  it('returns metadata snapshots without exposing the implementation', () => {
    const reg = createProviderRegistry()
    reg.register(fakeChatPlugin)
    const meta = reg.meta()
    expect(meta).toEqual([
      {
        id: 'fake-chat',
        label: 'Fake Chat',
        models: ['fake-mini', 'fake-pro'],
        defaultModel: 'fake-mini',
        keyPlaceholder: 'fk-…',
      },
    ])
  })

  it('returns needsBaseUrl in metadata only when set', () => {
    const reg = createProviderRegistry()
    reg.register({ ...fakeChatPlugin, needsBaseUrl: true })
    expect(reg.meta()[0]?.needsBaseUrl).toBe(true)
  })
})

describe('createMediaRegistry', () => {
  it('requires generateImage', () => {
    const reg = createMediaRegistry()
    expect(() => reg.register({ ...fakeMediaPlugin, generateImage: undefined as never })).toThrow(/generateImage/)
  })

  it('round-trips register/unregister', () => {
    const reg = createMediaRegistry()
    reg.register(fakeMediaPlugin)
    expect(reg.get('fake-media')).toBe(fakeMediaPlugin)
    reg.unregister('fake-media')
    expect(reg.get('fake-media')).toBeUndefined()
  })
})

describe('createSearchRegistry', () => {
  it('round-trips', () => {
    const reg = createSearchRegistry()
    reg.register(fakeSearchPlugin)
    expect(reg.list()).toEqual(['fake-search'])
    reg.unregister('fake-search')
    expect(reg.list()).toEqual([])
  })
})
