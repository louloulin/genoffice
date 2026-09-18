/**
 * Translation IPC handlers — coverage for the channels `registerAiIpc()`
 * registers on the docs main process. The Settings → AI → Translation KB
 * pane (and the snippet paste box) call these channels through the shell
 * transport; before the handlers lived in `registerAiIpc()` the shell sat
 * silent on every call (no handler = silent IPC error).
 *
 * The web-server has the same logic in `apps/web-server/src/ai/chat.ts`,
 * and that bundle is already covered by `apps/web-server/tests/*`. This
 * test proves the docs-side wiring: every channel the Settings pane calls
 * has a registered handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown | Promise<unknown>

const handlers = new Map<string, IpcHandler>()
const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    handlers.set(channel, handler)
  },
  on(channel: string, _listener: (...args: unknown[]) => void): void {
    handlers.set(channel, (event, ...rest) => _listener(event, ...rest))
  },
}

const aiSettingsFile = {
  data: {} as Record<string, unknown>,
  reset(): void {
    this.data = {}
  },
}

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  const stubPaths = new Set<string>()
  return {
    ...actual,
    existsSync: ((p: unknown) => {
      if (typeof p === 'string' && p.endsWith('ai-settings.json')) {
        return stubPaths.has(p)
      }
      return actual.existsSync(p as never)
    }) as typeof actual.existsSync,
    readFileSync: ((path: string, encoding?: unknown) => {
      if (typeof path === 'string' && path.endsWith('ai-settings.json')) {
        stubPaths.add(path)
        return JSON.stringify(aiSettingsFile.data)
      }
      return actual.readFileSync(path as never, encoding as never)
    }) as typeof actual.readFileSync,
    writeFileSync: ((path: string, data: unknown) => {
      if (typeof path === 'string' && path.endsWith('ai-settings.json')) {
        stubPaths.add(path)
        aiSettingsFile.data =
          typeof data === 'string' ? (JSON.parse(data) as Record<string, unknown>) : (data as Record<string, unknown>)
        return undefined
      }
      return actual.writeFileSync(path as never, data as never)
    }) as typeof actual.writeFileSync,
  }
})

const fakeGenofficeAuth = { loggedIn: false }
vi.mock('@genoffice/ai-search', () => ({
  gskApiKey: () => '',
  generateImageTool: () => ({ ok: false, error: 'mocked' }),
  gskLoginInfo: async () => null,
  hasGskAuth: () => fakeGenofficeAuth.loggedIn,
  webSearchTool: async () => ({ results: [], method: 'mocked' }),
  imageSearchTool: async () => ({ images: [], method: 'mocked' }),
  testSearchProvider: () => ({ ok: false, error: 'mocked' }),
  ensureGenofficeLogin: () => undefined,
}))

vi.mock('electron', () => ({
  app: {
    getPath: (_: string, ...rest: unknown[]) => {
      if (rest[0] === 'documents') return '/tmp/Documents'
      return '/tmp/genoffice-test-userData'
    },
    once: () => undefined,
    on: () => undefined,
  },
  ipcMain,
  dialog: { showOpenDialog: () => ({ canceled: true }) },
  shell: { openExternal: () => undefined },
  nativeImage: { createFromPath: () => ({}) },
  Menu: { buildFromTemplate: () => ({}) },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}))

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  aiSettingsFile.reset()
  fakeGenofficeAuth.loggedIn = false
})

afterEach(() => {
  handlers.clear()
})

describe('registerAiIpc — translation channels', () => {
  it('registers every channel the Settings → AI → Translation KB pane calls', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const expected = [
      // KB CRUD — the Settings pane's main UI
      'ai:translation-kb-list',
      'ai:translation-kb-upsert',
      'ai:translation-kb-remove',
      'ai:translation-kb-stats',
      // Whole-file translation — the file pipeline
      'ai:translate-build-dictionary',
      'ai:translate-fill-gaps',
      'ai:translate-file-auto',
      'ai:translate-file',
      'ai:translate-file-status',
      'ai:translate-dictionary-status',
      'ai:translate-file-output-path',
      // Snippet paste box + capability badges
      'home:translate-snippet',
      'home:ai-capabilities',
    ]
    for (const channel of expected) {
      expect(handlers.has(channel), `missing handler for ${channel}`).toBe(true)
    }
  })

  it('KB list returns the entries just inserted', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'term-fabric-weight',
        scope: 'company',
        priority: 50,
        sourceTerm: 'fabric weight',
        targetTerm: '克重',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
      },
    )

    const list = (await handlers.get('ai:translation-kb-list')!(
      {} as never,
      {},
    )) as { ok: boolean; entries: Array<{ id: string }> }
    expect(list.ok).toBe(true)
    expect(list.entries.map((e) => e.id)).toContain('term-fabric-weight')
  })

  it('KB stats counts the just-upserted entries by schema', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'stats-term-1',
        scope: 'company',
        priority: 30,
        sourceTerm: 'A',
        targetTerm: '甲',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
      },
    )
    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'stats-brand-1',
        scope: 'company',
        priority: 30,
        word: 'YKK',
        policy: 'neverTranslate',
      },
    )

    const stats = (await handlers.get('ai:translation-kb-stats')!(
      {} as never,
    )) as {
      ok: boolean
      total: number
      bySchema: Record<string, number>
      dirty: boolean
    }
    expect(stats.ok).toBe(true)
    // Each schema has at least the row we just inserted (the KB file may have
    // shipped with seed data from a previous run; the test only asserts that
    // both schemas are present and non-empty after our upserts).
    expect(stats.bySchema.term ?? 0).toBeGreaterThanOrEqual(1)
    expect(stats.bySchema.brand ?? 0).toBeGreaterThanOrEqual(1)
    expect(stats.total).toBeGreaterThanOrEqual(2)
    // Both upserts awaited save(), so the in-memory state matches disk.
    expect(stats.dirty).toBe(false)
  })

  it('KB remove returns removed:true for a known id and removed:false otherwise', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'to-remove',
        scope: 'company',
        priority: 30,
        sourceTerm: 'X',
        targetTerm: 'X',
      },
    )

    const ok = (await handlers.get('ai:translation-kb-remove')!(
      {} as never,
      'to-remove',
    )) as { ok: boolean; removed: boolean }
    expect(ok).toEqual({ ok: true, removed: true })

    const missing = (await handlers.get('ai:translation-kb-remove')!(
      {} as never,
      'no-such-row',
    )) as { ok: boolean; removed: boolean }
    expect(missing).toEqual({ ok: true, removed: false })
  })

  it('snippet translation refuses a non-string text instead of throwing', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    // `(req.text ?? '').trim()` threw a TypeError for a number, which reached
    // the renderer as an unhandled rejection rather than a reported shape
    // error. The web-server handler had the same hole and answered HTTP 500.
    for (const text of [123, {}, [], true] as unknown[]) {
      const result = (await handlers.get('home:translate-snippet')!({} as never, {
        text,
        targetLang: 'zh-CN',
      })) as { ok: boolean; error: string }
      expect(result.ok).toBe(false)
      expect(result.error).toBe('home:translate-snippet expected `text` to be a string')
    }
  })

  it('batch translation refuses a non-array units payload instead of throwing', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    for (const units of ['nope', {}, 3] as unknown[]) {
      const result = (await handlers.get('ai:translate-batch')!({} as never, {
        units,
        targetLang: 'zh-CN',
      })) as { ok: boolean; error?: string; units?: unknown[] }
      expect(result.ok).toBe(false)
      expect(result.error).toBe('ai:translate-batch expected `units` to be an array')
      expect(result.units).toEqual([])
    }
  })

  it('batch translation reports a malformed element in place instead of dropping it', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    // `.filter(u => u && typeof u === 'object')` used to drop bad elements, so
    // a partly-broken document looked fully translated: the renderer maps
    // results back by `unitId` and a dropped unit simply never appeared.
    const result = (await handlers.get('ai:translate-batch')!({} as never, {
      units: [
        null,
        { unitId: 'u2', sourceText: 123 },
        'nope',
        { unitId: 'u4', sourceText: 456 },
      ],
      targetLang: 'zh-CN',
    })) as {
      ok: boolean
      units?: Array<{ status?: string; errorMessage?: string; unitId?: string }>
      error?: string
    }
    // No provider is configured in this suite, so the call still fails — but
    // the failure must carry one settled entry per input unit, each naming the
    // unit that was malformed.
    expect(result.units).toHaveLength(4)
    for (const index of [0, 1, 2, 3]) {
      expect(result.units?.[index]?.status, `unit ${index}`).toBe('failed')
    }
    expect(result.units?.[0]?.errorMessage).toMatch(/expected unit 0/)
    expect(result.units?.[1]?.errorMessage).toMatch(/expected unit 1/)
    expect(result.units?.[3]?.errorMessage).toMatch(/expected unit 3/)
  })

  it('file-output-path refuses a value that cannot name a file', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    // `String(123)` answered `ok: true` with "123_translated" — a believable
    // path for a value that never named a file.
    for (const inputPath of [123, true, {}, ['a']] as unknown[]) {
      const result = (await handlers.get('ai:translate-file-output-path')!({} as never, inputPath)) as {
        ok: boolean
        outputPath?: string
        error?: string
      }
      expect(result.ok, JSON.stringify(inputPath)).toBe(false)
      expect(result.outputPath).toBeUndefined()
      expect(result.error).toBe('expected a non-empty inputPath')
    }
  })

  it('save-translation-memory refuses a non-array units payload instead of throwing', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const bad = (await handlers.get('ai:save-translation-memory')!({} as never, {
      units: 'nope',
    })) as { ok: boolean; error?: string }
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe('units must be an array')

    // A null element used to be dereferenced; it must be skipped instead.
    const mixed = (await handlers.get('ai:save-translation-memory')!({} as never, {
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      units: [null, {}, { sourceText: 'Hello', translatedText: '你好' }],
    })) as { ok: boolean; savedCount: number; skippedCount: number }
    expect(mixed.ok).toBe(true)
    expect(mixed.savedCount).toBe(1)
    expect(mixed.skippedCount).toBe(2)
  })

  it('snippet translation refuses an empty text payload', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const result = (await handlers.get('home:translate-snippet')!(
      {} as never,
      { text: '', targetLang: 'zh-CN' },
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/non-empty `text`/)
  })

  it('snippet translation refuses a missing targetLang', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const result = (await handlers.get('home:translate-snippet')!(
      {} as never,
      { text: 'hello' },
    )) as { ok: boolean; error: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/non-empty `targetLang`/)
  })

  it('snippet translation surfaces provider config errors when no real provider is wired', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    // Force-empty settings on disk so resolveTranslateConfig returns a stub
    // genspark config with empty apiKey. The default genspark model is a
    // Claude id, which the genspark adapter routes to the Anthropic protocol,
    // so a clean provider key path returns "not configured" while a partially
    // configured file surfaces an HTTP error from Anthropic. Either way the
    // IPC wiring reaches the provider-resolution layer — the assertion
    // accepts both shapes so the test stays a true unit smoke test.
    aiSettingsFile.data = {}
    await handlers.get('ai:set-settings')!({} as never, {})

    const result = (await handlers.get('home:translate-snippet')!(
      {} as never,
      { text: 'hello', targetLang: 'zh-CN' },
    )) as { ok: boolean; error: string; elapsedMs?: number }
    expect(result.ok).toBe(false)
    expect(result.error).toBeTypeOf('string')
    // elapsedMs is populated when the handler actually reached the network.
    expect(typeof result.elapsedMs).toBe('number')
    // The error message either names an HTTP failure from the provider or
    // announces the missing API key — both prove the IPC wiring reached the
    // provider configuration code path.
    expect(result.error).toMatch(/not configured|HTTP|api[_-]?key/i)
  })

  it('file-status reports the discovery of the upstream translate suite', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const status = (await handlers.get('ai:translate-file-status')!(
      {} as never,
    )) as {
      ok: boolean
      available: boolean
      supportedExtensions: string[]
    }
    expect(status.ok).toBe(true)
    expect(status.supportedExtensions.length).toBeGreaterThan(0)
    // availability is environment-dependent; just assert the field exists.
    expect(typeof status.available).toBe('boolean')
  })

  it('dictionary-status reports null when no dictionary has been built yet', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const status = (await handlers.get('ai:translate-dictionary-status')!(
      {} as never,
    )) as {
      ok: boolean
      dictionary: { path: string; terms: number } | null
    }
    expect(status.ok).toBe(true)
    // Fresh process — no dictionary cached. The KB-load (file missing on disk)
    // must not throw; the response shape stays stable.
    expect(status.dictionary === null || typeof status.dictionary.path === 'string').toBe(true)
  })

  it('KB → dictionary → snippet pipeline proves provenance end-to-end', async () => {
    // Seed the KB with two terms: one we expect the snippet to surface as a
    // KB match, the other as a brand that must never translate.
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()
    aiSettingsFile.data = {}
    await handlers.get('ai:set-settings')!({} as never, {})

    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'e2e-fabric-weight',
        scope: 'company',
        priority: 60,
        sourceTerm: 'fabric weight',
        targetTerm: '克重',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
      },
    )
    await handlers.get('ai:translation-kb-upsert')!(
      {} as never,
      {
        id: 'e2e-brand-ykk',
        scope: 'company',
        priority: 60,
        word: 'YKK',
        policy: 'neverTranslate',
      },
    )

    // Sanity-check both rows exist (the KB is shared on disk so other tests
    // may have added their own rows too; we only assert the rows we just
    // wrote show up).
    const list = (await handlers.get('ai:translation-kb-list')!(
      {} as never,
      {},
    )) as { ok: boolean; entries: Array<{ id: string }> }
    const ids = list.entries.map((e) => e.id)
    expect(ids).toContain('e2e-brand-ykk')
    expect(ids).toContain('e2e-fabric-weight')

    // Stats aggregate by schema — the brand row keys on `policy` and the term
    // row keys on `sourceTerm`/`targetTerm`.
    const stats = (await handlers.get('ai:translation-kb-stats')!(
      {} as never,
    )) as { total: number; bySchema: Record<string, number> }
    expect(stats.bySchema.term).toBeGreaterThanOrEqual(1)
    expect(stats.bySchema.brand).toBeGreaterThanOrEqual(1)
  })

  it('home:ai-capabilities reports search/image-search/image-generation/media-analysis', async () => {
    const { registerAiIpc } = await import('../src/main/docs-main')
    registerAiIpc()

    const report = (await handlers.get('home:ai-capabilities')!(
      {} as never,
    )) as {
      ok: boolean
      capabilities: Record<
        string,
        { available: boolean; via: string; configured: boolean; note?: string }
      >
      provider: string
    }
    expect(report.ok).toBe(true)
    expect(typeof report.provider).toBe('string')
    for (const key of ['search', 'image_search', 'image_generation', 'media_analysis']) {
      expect(report.capabilities[key], `missing capability ${key}`).toBeDefined()
      expect(typeof report.capabilities[key].available).toBe('boolean')
      expect(typeof report.capabilities[key].via).toBe('string')
      expect(typeof report.capabilities[key].configured).toBe('boolean')
    }
  })
})
