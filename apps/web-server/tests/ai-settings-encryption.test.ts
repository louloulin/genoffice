/**
 * ai-settings encryption at the disk boundary (A36/A37) + key redaction
 * round-trip (A38).
 *
 * Pinned behaviour:
 *   - With GENOFFICE_MASTER_KEY set, `ai:set-settings` writes envelopes
 *     (`v1:<keyId>:...`) to DATA_DIR/ai-settings.json — never plaintext.
 *   - Re-loading the module with the same key decrypts back into memory;
 *     `ai:get-settings` still redacts before anything leaves the process.
 *   - A client that echoes a redacted value back through set-settings keeps
 *     the stored key (the round-trip must not destroy credentials).
 *   - Ciphertext on disk without a usable master key fails startup (A37),
 *     including a tampered record (GCM auth failure) — never a silent
 *     fallback to defaults, which would wipe the operator's keys.
 *   - Without GENOFFICE_MASTER_KEY the legacy plaintext file remains
 *     (deployments predating encryption keep working).
 *
 * Isolation pattern from ai-provider-config.test.ts / audit-log-tenant.test.ts:
 * TMP DATA_DIR + vi.stubEnv + vi.resetModules() per case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MASTER_KEY = 'a'.repeat(64)
let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'ai-settings-enc-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const settingsFile = () => join(TMP, 'ai-settings.json')

async function loadChat() {
  return await import('../src/ai/chat')
}

async function setKey(chat: Awaited<ReturnType<typeof loadChat>>, key: string): Promise<void> {
  const { getHandler } = await import('../src/common/index')
  const settings = JSON.parse(JSON.stringify(chat.aiSettings)) as typeof chat.aiSettings
  settings.providers.openai = { ...settings.providers.openai, apiKey: key }
  getHandler('ai:set-settings')(null, settings)
}

describe('ai-settings encryption (A36/A37/A38)', () => {
  it('persists envelopes, never plaintext, when a master key is set', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setKey(chat, 'sk-live-abcd1234')

    expect(existsSync(settingsFile())).toBe(true)
    const raw = readFileSync(settingsFile(), 'utf8')
    expect(raw).not.toContain('sk-live-abcd1234')
    expect(raw).toContain('"v1:')

    // In-memory stays plaintext so the AI paths keep working unchanged.
    expect(chat.aiSettings.providers.openai?.apiKey).toBe('sk-live-abcd1234')
  })

  it('decrypts on reload and redacts on read', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setKey(chat, 'sk-live-abcd1234')

    // Fresh module state over the same file + key.
    vi.resetModules()
    const reloaded = await loadChat()
    reloaded.registerAiCoreHandlers()
    expect(reloaded.aiSettings.providers.openai?.apiKey).toBe('sk-live-abcd1234')

    const { getHandler } = await import('../src/common/index')
    const redacted = getHandler('ai:get-settings')(null) as {
      providers: Record<string, { apiKey?: string }>
    }
    expect(redacted.providers.openai?.apiKey).toBe('sk-***1234')
    expect(JSON.stringify(redacted)).not.toContain('sk-live-abcd1234')
  })

  it('keeps the stored key when a client echoes a redacted value back', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setKey(chat, 'sk-live-abcd1234')

    // The client reads redacted settings and saves them back untouched.
    const echo = JSON.parse(JSON.stringify(chat.aiSettings)) as typeof chat.aiSettings
    echo.providers.openai = { ...echo.providers.openai, apiKey: 'sk-***1234' }
    const { getHandler } = await import('../src/common/index')
    getHandler('ai:set-settings')(null, echo)

    expect(chat.aiSettings.providers.openai?.apiKey).toBe('sk-live-abcd1234')
    // And the persisted file still only holds the envelope of the real key.
    const raw = readFileSync(settingsFile(), 'utf8')
    expect(raw).toContain('"v1:')
    expect(raw).not.toContain('sk-***1234')
  })

  it('fails startup when ciphertext exists but the master key is gone', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const { encryptSecret } = await import('../src/common/secret-store')
    const envelope = encryptSecret('sk-live-abcd1234')
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        provider: 'openai',
        providers: { openai: { apiKey: envelope } },
      }),
      'utf8',
    )

    // New module state (fresh key cache) without the key env: load must throw,
    // not silently fall back to defaults.
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('DATA_DIR', TMP)
    vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
    vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
    await expect(loadChat()).rejects.toThrow(/refusing to start.*ai-settings\.json.*master key/)
  })

  it('fails startup when a stored record was tampered with', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const { encryptSecret } = await import('../src/common/secret-store')
    const envelope = encryptSecret('sk-live-abcd1234')
    // Flip a character inside the ciphertext body.
    const parts = envelope.split(':')
    const body = parts[3]!
    parts[3] = (body.startsWith('A') ? `B${body.slice(1)}` : `A${body.slice(1)}`)
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        provider: 'openai',
        providers: { openai: { apiKey: parts.join(':') } },
      }),
      'utf8',
    )

    vi.resetModules()
    await expect(loadChat()).rejects.toThrow(/refusing to start.*ai-settings\.json/)
  })

  it('keeps the legacy plaintext file when no master key is configured', async () => {
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setKey(chat, 'sk-legacy-plain')

    const raw = readFileSync(settingsFile(), 'utf8')
    expect(raw).toContain('sk-legacy-plain')
    expect(raw).not.toContain('"v1:')
  })
})

/**
 * The media (`media.providers[<id>].apiKey`) and search
 * (`search.providers[<id>].apiKey`) maps hold real user-entered credentials
 * too. The same envelope/redaction/echo guarantees must hold for them — the
 * gap that A4/A5/A37/A38 called out.
 */
describe('ai-settings encryption covers nested media/search maps', () => {
  async function setNestedKeys(
    chat: Awaited<ReturnType<typeof loadChat>>,
    mediaKey: string,
    searchKey: string,
  ): Promise<void> {
    const { getHandler } = await import('../src/common/index')
    const settings = JSON.parse(JSON.stringify(chat.aiSettings)) as typeof chat.aiSettings
    settings.media = {
      ...settings.media!,
      providers: {
        ...settings.media!.providers,
        openai: { ...settings.media!.providers.openai, apiKey: mediaKey },
      },
    }
    settings.search = {
      ...settings.search!,
      providers: { ...settings.search!.providers, serper: { apiKey: searchKey } },
    }
    getHandler('ai:set-settings')(null, settings)
  }

  it('encrypts media/search keys at rest and decrypts on reload', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setNestedKeys(chat, 'sk-media-9999', 'srch-search-8888')

    const raw = readFileSync(settingsFile(), 'utf8')
    expect(raw).not.toContain('sk-media-9999')
    expect(raw).not.toContain('srch-search-8888')
    // Both nested keys are envelopes, alongside the top-level provider keys.
    expect((raw.match(/"v1:/g) ?? []).length).toBeGreaterThanOrEqual(2)

    vi.resetModules()
    const reloaded = await loadChat()
    reloaded.registerAiCoreHandlers()
    expect(reloaded.aiSettings.media?.providers.openai?.apiKey).toBe('sk-media-9999')
    expect(reloaded.aiSettings.search?.providers.serper?.apiKey).toBe('srch-search-8888')
  })

  it('redacts media/search keys through ai:get-settings', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setNestedKeys(chat, 'sk-media-9999', 'srch-search-8888')

    const { getHandler } = await import('../src/common/index')
    const redacted = getHandler('ai:get-settings')(null) as {
      media?: { providers: Record<string, { apiKey?: string }> }
      search?: { providers: Record<string, { apiKey?: string }> }
    }
    expect(redacted.media?.providers.openai?.apiKey).toMatch(/\*\*\*/)
    expect(redacted.search?.providers.serper?.apiKey).toMatch(/\*\*\*/)
    const text = JSON.stringify(redacted)
    expect(text).not.toContain('sk-media-9999')
    expect(text).not.toContain('srch-search-8888')
  })

  it('keeps stored media/search keys when a client echoes redacted values', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const chat = await loadChat()
    chat.registerAiCoreHandlers()
    await setNestedKeys(chat, 'sk-media-9999', 'srch-search-8888')

    const echo = JSON.parse(JSON.stringify(chat.aiSettings)) as typeof chat.aiSettings
    echo.media = {
      ...echo.media!,
      providers: {
        ...echo.media!.providers,
        openai: { ...echo.media!.providers.openai, apiKey: 'sk-***9999' },
      },
    }
    echo.search = {
      ...echo.search!,
      providers: { ...echo.search!.providers, serper: { apiKey: 'srh***8888' } },
    }
    const { getHandler } = await import('../src/common/index')
    getHandler('ai:set-settings')(null, echo)

    expect(chat.aiSettings.media?.providers.openai?.apiKey).toBe('sk-media-9999')
    expect(chat.aiSettings.search?.providers.serper?.apiKey).toBe('srch-search-8888')
  })

  it('fails startup when a nested media envelope exists without the master key', async () => {
    vi.stubEnv('GENOFFICE_MASTER_KEY', MASTER_KEY)
    const { encryptSecret } = await import('../src/common/secret-store')
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        provider: 'openai',
        providers: {},
        media: {
          imageProvider: 'openai',
          analysisProvider: 'openai',
          videoAnalysisProvider: 'openai',
          providers: {
            openai: {
              apiKey: encryptSecret('sk-media-9999'),
              imageModel: 'gpt-image-1',
              analysisModel: 'gpt-4o',
            },
          },
        },
      }),
      'utf8',
    )

    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('DATA_DIR', TMP)
    vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
    vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
    await expect(loadChat()).rejects.toThrow(/refusing to start.*ai-settings\.json/)
  })

  it('fails closed on an unrecognized envelope format', async () => {
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        provider: 'openai',
        providers: { openai: { apiKey: 'v1:deadbeef:not-a-real-envelope' } },
      }),
      'utf8',
    )
    await expect(loadChat()).rejects.toThrow(/refusing to start.*ai-settings\.json/)
  })
})
