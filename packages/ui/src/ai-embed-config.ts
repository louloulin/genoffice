import { isAiPanelPlacement, type AiPanelPlacement } from './ai-panel-prefs'

/**
 * The embed hosts (web-server's `/embed` page and the office-ai UI host) inject a
 * `genoffice-embed-config` meta tag describing how this renderer was mounted. Only
 * the layout-relevant field is read here — the bridges read the rest for the
 * handshake.
 *
 * The embedder's choice is an initial/default value only: on a desktop install the
 * user's stored preference still wins, but a plain embed host has no settings UI,
 * so whatever the embedder asked for is what the user gets.
 */
const EMBED_CONFIG_META = 'genoffice-embed-config'

let read: AiPanelPlacement | null | undefined

/** Placement requested by the embedding host, or null when not embedded / unspecified. */
export function embedAiPanelPlacement(): AiPanelPlacement | null {
  if (read !== undefined) return read
  read = null
  try {
    const meta = document.querySelector(`meta[name="${EMBED_CONFIG_META}"]`)
    const content = meta?.getAttribute('content')
    if (content) {
      const config = JSON.parse(content) as Record<string, unknown>
      if (isAiPanelPlacement(config.aiPanel)) read = config.aiPanel
    }
  } catch {
    /* malformed meta — treat as "no embedder preference" */
  }
  return read
}

/** Resolves the placement that should actually be applied, embedder first. */
export function resolveAiPanelPlacement(stored: AiPanelPlacement): AiPanelPlacement {
  return embedAiPanelPlacement() ?? stored
}
