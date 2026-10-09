import { describe, expect, it, vi } from 'vitest'

/**
 * The store reads `document` when a function runs, not at import, so a stubbed
 * `document` (+ a fresh module registry, which also clears the embed meta's
 * one-shot cache) is enough to keep this suite on the node environment like its
 * siblings. The host API is handed over through `registerAiPanelPrefsHost`
 * rather than a `window` global, matching how each app boots it.
 */
async function loadStore(options: { meta?: string | null } = {}) {
  const { meta = null } = options
  vi.resetModules()
  const dataset: Record<string, string> = {}
  vi.stubGlobal('document', {
    documentElement: { dataset },
    querySelector: () => (meta === null ? null : { getAttribute: () => meta }),
  })
  const store = await import('../src/ai-panel-prefs-store')
  return { store, dataset }
}

describe('setAiPanelPlacement', () => {
  it('mirrors the switch onto <html> and persists it through the registered host', async () => {
    const setAiPanelPrefs = vi.fn(async () => ({}))
    const { store, dataset } = await loadStore()
    store.registerAiPanelPrefsHost({ setAiPanelPrefs })

    store.setAiPanelPlacement('floating')
    expect(dataset.aiPlacement).toBe('floating')
    expect(setAiPanelPrefs).toHaveBeenCalledWith({ placement: 'floating' })

    store.setAiPanelPlacement('right')
    expect(dataset.aiPlacement).toBe('right')
    expect(setAiPanelPrefs).toHaveBeenLastCalledWith({ placement: 'right' })
  })

  it('does nothing when the placement already matches', async () => {
    const setAiPanelPrefs = vi.fn(async () => ({}))
    const { store } = await loadStore()
    store.registerAiPanelPrefsHost({ setAiPanelPrefs })

    // 'right' is the default the store already holds.
    store.setAiPanelPlacement('right')
    expect(setAiPanelPrefs).not.toHaveBeenCalled()
  })

  it('keeps the change local to the page where no host is registered', async () => {
    const { store, dataset } = await loadStore()
    expect(() => store.setAiPanelPlacement('floating')).not.toThrow()
    expect(dataset.aiPlacement).toBe('floating')
  })

  it('swallows a host that cannot write, rather than surfacing it', async () => {
    const setAiPanelPrefs = vi.fn(() => Promise.reject(new Error('read-only host')))
    const { store, dataset } = await loadStore()
    store.registerAiPanelPrefsHost({ setAiPanelPrefs })

    store.setAiPanelPlacement('floating')
    await Promise.resolve()
    expect(dataset.aiPlacement).toBe('floating')
    expect(setAiPanelPrefs).toHaveBeenCalledOnce()
  })

  it("leaves an embedder's placement effective while still recording the choice", async () => {
    // Decision: the embedding host's value is what the user gets in an embed.
    // A host that persists later (the desktop app) is unaffected by this meta —
    // it is only present on the served embed pages.
    const setAiPanelPrefs = vi.fn(async () => ({}))
    const { store, dataset } = await loadStore({ meta: '{"app":"docs","aiPanel":"left"}' })
    store.registerAiPanelPrefsHost({ setAiPanelPrefs })

    store.setAiPanelPlacement('floating')
    expect(dataset.aiPlacement).toBe('left')
    expect(setAiPanelPrefs).toHaveBeenCalledWith({ placement: 'floating' })
  })
})
