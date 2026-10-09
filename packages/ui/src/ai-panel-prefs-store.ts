import { useSyncExternalStore } from 'react'
import {
  DEFAULT_AI_PANEL_PREFS,
  aiPanelZoom,
  normalizeAiPanelPrefs,
  sameAiPanelPrefs,
  type AiPanelPlacement,
  type AiPanelPrefs,
} from './ai-panel-prefs'
import { resolveAiPanelPlacement } from './ai-embed-config'

let current: AiPanelPrefs = DEFAULT_AI_PANEL_PREFS
let currentPlacement: AiPanelPlacement = DEFAULT_AI_PANEL_PREFS.placement
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Mirrors the effective placement onto `<html data-ai-placement>`, which every
 * layout rule in ai-panel-placement.css keys off. The embedder's request, when
 * present, beats the stored preference — see ai-embed-config.ts.
 */
function applyPlacement(stored: AiPanelPlacement): void {
  const effective = resolveAiPanelPlacement(stored)
  currentPlacement = effective
  document.documentElement.dataset.aiPlacement = effective
}

/**
 * Applies the renderer's *default* placement before any preference arrives, so an
 * embedding host that asks for `floating` gets it even though no host bridge ever
 * delivers prefs there. Call once at boot (index.html already carries the `right`
 * literal, so a plain standalone run is a no-op).
 */
export function initAiPanelPlacement(): void {
  applyPlacement(DEFAULT_AI_PANEL_PREFS.placement)
}

/**
 * Renderer-side entry for the shell's AI panel preferences: mirrors the font
 * size onto `<html data-ai-font-size>` plus `--ai-font-zoom` (see
 * ai-panel-prefs.css), mirrors the placement onto `<html data-ai-placement>`
 * (see ai-panel-placement.css) and feeds `useAiPanelPrefs()` consumers such as
 * the composer's spellcheck flag.
 */
export function applyAiPanelPrefs(raw: unknown): void {
  const next = normalizeAiPanelPrefs(raw)
  if (sameAiPanelPrefs(next, current)) return
  current = next
  const html = document.documentElement
  if (next.fontSize === 'default') {
    delete html.dataset.aiFontSize
    html.style.removeProperty('--ai-font-zoom')
  } else {
    html.dataset.aiFontSize = next.fontSize
    html.style.setProperty('--ai-font-zoom', String(aiPanelZoom(next)))
  }
  applyPlacement(next.placement)
  for (const listener of listeners) listener()
}

/**
 * The window's host API object, under whichever global the app exposes it
 * (`desktop` in docs, `desktopApi` in sheets, `pdfApi` in pdf, …). An editor
 * window registers it at boot so the header toggle can persist; an embed host
 * registers nothing, in which case the switch stays local to the page.
 */
interface AiPanelPrefsHost {
  setAiPanelPrefs?: (patch: Partial<AiPanelPrefs>) => Promise<unknown>
}

let prefsHost: AiPanelPrefsHost | null = null

/**
 * Hands the store the host API to write through, called from each renderer's
 * boot next to the `getAiPanelPrefs` read. The global's name is app-specific, so
 * the store takes the object rather than guessing the name off `window`.
 */
export function registerAiPanelPrefsHost(host: unknown): void {
  prefsHost = (host ?? null) as AiPanelPrefsHost | null
}

/**
 * Switches the placement from inside the renderer — the panel header's
 * dock/floating toggle, which the settings window is no longer the only way to
 * reach. Applied before the write so the layout flips on the click's own frame;
 * the shell echoes the normalized value back on `app:ai-panel-prefs-changed`,
 * which resolves to a no-op here because it equals what was just applied.
 */
export function setAiPanelPlacement(placement: AiPanelPlacement): void {
  if (current.placement === placement) return
  current = { ...current, placement }
  applyPlacement(placement)
  for (const listener of listeners) listener()
  try {
    void prefsHost?.setAiPanelPrefs?.({ placement })?.catch(() => {
      /* a host that cannot persist keeps the change local to this page */
    })
  } catch {
    /* same, for a host that throws instead of rejecting */
  }
}

export function useAiPanelPrefs(): AiPanelPrefs {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT_AI_PANEL_PREFS,
  )
}

/** Effective placement (embedder override applied) — drives the ball vs. dock branch. */
export function useAiPanelPlacement(): AiPanelPlacement {
  return useSyncExternalStore(
    subscribe,
    () => currentPlacement,
    () => DEFAULT_AI_PANEL_PREFS.placement,
  )
}
