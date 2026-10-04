/**
 * Unit coverage for the request-settings sanitize layer (A2/A3).
 *
 * The layer sits between the wire and every provider call: embed (JWT)
 * callers get their network fields stripped and backfilled from the server's
 * persisted settings; local/operator callers keep BYOK but their baseUrl
 * overrides must hit the loopback-or-allowlist set or the whole request is
 * rejected before any upstream call.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@genoffice/ai-provider'

const { isEmbedCaller, sanitizeRequestSettings } = await import('../src/ai/settings-sanitize')

function serverSettings(): AiSettings {
  const s = defaultAiSettings()
  s.providers.openai = { ...s.providers.openai, apiKey: 'server-openai-key', baseUrl: 'https://api.openai.com/v1' }
  s.providers.minimax = { ...s.providers.minimax, apiKey: 'server-minimax-key' }
  return s
}

let savedAllowlist: string | undefined

beforeEach(() => {
  savedAllowlist = process.env.GENOFFICE_BASEURL_ALLOWLIST
  delete process.env.GENOFFICE_BASEURL_ALLOWLIST
})

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.GENOFFICE_BASEURL_ALLOWLIST
  else process.env.GENOFFICE_BASEURL_ALLOWLIST = savedAllowlist
})

describe('isEmbedCaller', () => {
  it('is true when the event carries a JWT subject', () => {
    expect(isEmbedCaller({ userId: 'embed-guest-1', sender: { id: -1 } })).toBe(true)
  })
  it('is false for a legacy no-JWT event (local renderer / dev)', () => {
    expect(isEmbedCaller({ sender: { id: -1 } })).toBe(false)
    expect(isEmbedCaller({ userId: '' })).toBe(false)
    expect(isEmbedCaller(undefined)).toBe(false)
  })
})

describe('sanitizeRequestSettings — no override', () => {
  it('returns the server settings untouched', () => {
    const server = serverSettings()
    const result = sanitizeRequestSettings({ embedCaller: true, requestSettings: undefined, serverSettings: server })
    expect(result).toEqual({ ok: true, settings: server })
  })
})

describe('sanitizeRequestSettings — embed caller (JWT)', () => {
  it('strips provider apiKey/baseUrl and backfills from the server settings', () => {
    const request = {
      provider: 'openai',
      providers: {
        openai: { apiKey: 'evil-key', baseUrl: 'http://169.254.169.254/latest', model: 'gpt-4o' },
      },
    } as unknown as AiSettings
    const result = sanitizeRequestSettings({ embedCaller: true, requestSettings: request, serverSettings: serverSettings() })
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.settings.providers.openai.apiKey).toBe('server-openai-key')
    expect(result.settings.providers.openai.baseUrl).toBe('https://api.openai.com/v1')
    // Non-network choices survive.
    expect(result.settings.providers.openai.model).toBe('gpt-4o')
    expect(result.settings.provider).toBe('openai')
  })

  it('strips media and search provider credentials and backfills them', () => {
    const request = {
      providers: {},
      media: { providers: { openai: { apiKey: 'evil-media-key', baseUrl: 'http://10.0.0.5', imageModel: 'dall-e-3' } } },
      search: { providers: { tavily: { apiKey: 'evil-search-key' } } },
    } as unknown as AiSettings
    const server = serverSettings()
    server.media = { providers: { openai: { apiKey: 'server-media-key', baseUrl: 'https://api.openai.com/v1', imageModel: 'dall-e-3', analysisModel: 'gpt-4o' } } }
    server.search = { providers: { tavily: { apiKey: 'server-search-key' } } }
    const result = sanitizeRequestSettings({ embedCaller: true, requestSettings: request, serverSettings: server })
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.settings.media?.providers.openai?.apiKey).toBe('server-media-key')
    expect(result.settings.media?.providers.openai?.baseUrl).toBe('https://api.openai.com/v1')
    expect(result.settings.media?.providers.openai?.imageModel).toBe('dall-e-3')
    expect(result.settings.search?.providers.tavily?.apiKey).toBe('server-search-key')
  })

  it('does not conjure configuration for a provider the server never set up', () => {
    const request = {
      provider: 'deepseek',
      providers: { deepseek: { apiKey: 'evil-key', baseUrl: 'http://169.254.169.254' } },
    } as unknown as AiSettings
    const result = sanitizeRequestSettings({ embedCaller: true, requestSettings: request, serverSettings: serverSettings() })
    if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`)
    expect(result.settings.providers.deepseek?.apiKey).toBeUndefined()
    expect(result.settings.providers.deepseek?.baseUrl).toBeUndefined()
  })

  it('mutates neither the request object nor the server settings', () => {
    const request = {
      providers: { openai: { apiKey: 'evil-key', baseUrl: 'http://169.254.169.254', model: 'gpt-4o' } },
    } as unknown as AiSettings
    const server = serverSettings()
    sanitizeRequestSettings({ embedCaller: true, requestSettings: request, serverSettings: server })
    expect((request.providers as Record<string, { apiKey?: string }>).openai.apiKey).toBe('evil-key')
    expect(server.providers.openai.apiKey).toBe('server-openai-key')
  })
})

describe('sanitizeRequestSettings — local/operator (BYOK with allowlist)', () => {
  it('keeps apiKey and a loopback baseUrl intact', () => {
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:8080', 'http://[::1]:9000']) {
      const request = {
        providers: { openai: { apiKey: 'my-own-key', baseUrl: url, model: 'llama3' } },
      } as unknown as AiSettings
      const result = sanitizeRequestSettings({ embedCaller: false, requestSettings: request, serverSettings: serverSettings() })
      if (!result.ok) throw new Error(`expected ok for ${url}, got: ${result.reason}`)
      expect(result.settings.providers.openai.apiKey).toBe('my-own-key')
      expect(result.settings.providers.openai.baseUrl).toBe(url)
    }
  })

  it('rejects a non-allowlisted host with a reason naming it, before any upstream call', () => {
    const request = {
      providers: { openai: { apiKey: 'k', baseUrl: 'http://169.254.169.254/latest/meta-data' } },
    } as unknown as AiSettings
    const result = sanitizeRequestSettings({ embedCaller: false, requestSettings: request, serverSettings: serverSettings() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('169.254.169.254')
  })

  it('admits hosts listed in GENOFFICE_BASEURL_ALLOWLIST', () => {
    process.env.GENOFFICE_BASEURL_ALLOWLIST = 'api.deepseek.com, Internal.Proxy.Example '
    const request = {
      providers: {
        openai: { apiKey: 'k', baseUrl: 'http://internal.proxy.example:8443/v1' },
        minimax: { apiKey: 'k2', baseUrl: 'https://api.deepseek.com' },
      },
    } as unknown as AiSettings
    const result = sanitizeRequestSettings({ embedCaller: false, requestSettings: request, serverSettings: serverSettings() })
    expect(result.ok).toBe(true)
  })

  it('rejects an invalid URL and a non-http(s) protocol', () => {
    const bad = {
      providers: { openai: { apiKey: 'k', baseUrl: 'not a url' } },
    } as unknown as AiSettings
    expect(sanitizeRequestSettings({ embedCaller: false, requestSettings: bad, serverSettings: serverSettings() }).ok).toBe(false)
    const ftp = {
      providers: { openai: { apiKey: 'k', baseUrl: 'ftp://internal.proxy.example' } },
    } as unknown as AiSettings
    const result = sanitizeRequestSettings({ embedCaller: false, requestSettings: ftp, serverSettings: serverSettings() })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('protocol')
  })
})
