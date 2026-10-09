import { describe, expect, it, vi } from 'vitest'

import {
  AI_PANEL_PLACEMENTS,
  DEFAULT_AI_PANEL_PREFS,
  isAiPanelPlacement,
  normalizeAiPanelPrefs,
  sameAiPanelPrefs,
} from '../src/ai-panel-prefs'

describe('placement enum', () => {
  it('accepts exactly the three documented placements', () => {
    for (const value of AI_PANEL_PLACEMENTS) expect(isAiPanelPlacement(value)).toBe(true)
    for (const value of ['', 'LEFT', 'top', 'bottom', 'dock', null, 1, undefined]) {
      expect(isAiPanelPlacement(value)).toBe(false)
    }
  })

  it('defaults to the right dock', () => {
    expect(DEFAULT_AI_PANEL_PREFS.placement).toBe('right')
  })
})

describe('normalizeAiPanelPrefs', () => {
  it('keeps a stored placement as-is', () => {
    for (const placement of AI_PANEL_PLACEMENTS) {
      expect(normalizeAiPanelPrefs({ placement }).placement).toBe(placement)
    }
  })

  it('falls back to the default when placement is missing or malformed', () => {
    // An app-settings.json written before this field existed must still load.
    expect(normalizeAiPanelPrefs({ fontSize: 'large' }).placement).toBe('right')
    expect(normalizeAiPanelPrefs({ placement: 'sideways' }).placement).toBe('right')
    expect(normalizeAiPanelPrefs(null).placement).toBe('right')
    expect(normalizeAiPanelPrefs(undefined).placement).toBe('right')
    expect(normalizeAiPanelPrefs(42).placement).toBe('right')
  })
})

describe('sameAiPanelPrefs', () => {
  const base = normalizeAiPanelPrefs({ fontSize: 'default', spellcheck: true })

  it('compares the placement too', () => {
    // A placement-only change is the whole point of the field, so it must not be
    // swallowed by the store's identity check (it early-returns when equal).
    expect(sameAiPanelPrefs(base, normalizeAiPanelPrefs({ ...base, placement: 'left' }))).toBe(false)
    expect(sameAiPanelPrefs(base, normalizeAiPanelPrefs({ ...base, placement: 'floating' }))).toBe(
      false,
    )
    expect(sameAiPanelPrefs(base, normalizeAiPanelPrefs({ ...base }))).toBe(true)
  })
})

describe('resolveAiPanelPlacement', () => {
  /** ai-embed-config.ts reads `document` once and caches the result. */
  async function loadWithMeta(content: string | null): Promise<typeof import('../src/ai-embed-config')> {
    vi.resetModules()
    vi.stubGlobal('document', {
      querySelector: () => (content === null ? null : { getAttribute: () => content }),
    })
    return import('../src/ai-embed-config')
  }

  it("lets the embedder's request win over the stored preference", async () => {
    const { resolveAiPanelPlacement } = await loadWithMeta('{"app":"docs","aiPanel":"floating"}')
    expect(resolveAiPanelPlacement('right')).toBe('floating')
    expect(resolveAiPanelPlacement('left')).toBe('floating')
  })

  it('falls back to the stored preference when there is no embedder request', async () => {
    const { resolveAiPanelPlacement } = await loadWithMeta(null)
    expect(resolveAiPanelPlacement('left')).toBe('left')
    expect(resolveAiPanelPlacement('right')).toBe('right')
  })

  it('ignores a meta value that is not a known placement', async () => {
    const { resolveAiPanelPlacement } = await loadWithMeta('{"app":"docs","aiPanel":"sideways"}')
    expect(resolveAiPanelPlacement('left')).toBe('left')
  })

  it('ignores a malformed meta rather than throwing', async () => {
    const { resolveAiPanelPlacement } = await loadWithMeta('not json')
    expect(resolveAiPanelPlacement('floating')).toBe('floating')
  })

  it('ignores a meta that omits aiPanel entirely', async () => {
    const { resolveAiPanelPlacement } = await loadWithMeta('{"app":"docs","mode":"view"}')
    expect(resolveAiPanelPlacement('right')).toBe('right')
  })
})