/**
 * Provider Plugin Interface — sdk1.md §3.1.
 *
 * Lets third-party developers ship their own LLM / image / search provider
 * as an npm package (e.g. `@genoffice/provider-anthropic`) and have the
 * GenOffice web-server pick it up at boot via:
 *
 *   1. Static import (zero-config for first-party plugins):
 *        import { anthropicPlugin } from '@genoffice/provider-anthropic'
 *        providerRegistry.register(anthropicPlugin)
 *
 *   2. `genoffice.providers.json` config (for runtime / third-party plugins):
 *        { "providers": [
 *            { "name": "@scope/my-plugin", "version": "^1.0.0" }
 *          ] }
 *      The web-server reads this file at boot, dynamically imports each
 *      module, and registers the default export as a plugin.
 *
 *   3. Programmatic registration (for tests and embedded use):
 *        providerRegistry.register(myPlugin)
 *        providerRegistry.unregister('my-plugin-id')
 *
 * Stability:
 *   - `AiProviderPlugin` is the stable contract; new optional fields may be
 *     added at any minor version, but removing or renaming required fields
 *     is a breaking change.
 *   - `ProviderRegistry` is also stable; existing methods cannot be renamed.
 */

import type {
  AiChatRequest,
  AiChatResponse,
  AiAnalysisProtocol,
  AiImageProtocol,
  AiStreamChunk,
  AiStreamRequest,
} from './types'

// ──────────────────────────────────────────────────────────────────────────────
// Chat plugin
// ──────────────────────────────────────────────────────────────────────────────

/**
 * A provider plugin owns its own configuration, model catalogue, and chat
 * implementation. The plugin's `id` is what shows up in `AiSettings.provider`
 * and the `?provider=` URL flag.
 */
export interface AiProviderPlugin {
  /** Stable string id, lowercase, dash-separated. e.g. `anthropic`. */
  id: string
  /** Display label for settings UI. e.g. `Anthropic (Claude)`. */
  label: string
  /** Available models surfaced in the picker. Empty array is allowed. */
  models: string[]
  /** Default model id when the user has not picked one. */
  defaultModel: string
  /** Placeholder text for the API key field. e.g. `sk-ant-…`. */
  keyPlaceholder: string
  /** Whether the picker should ask for a custom `baseUrl`. */
  needsBaseUrl?: boolean

  /**
   * Validate the user's API key + baseUrl. Throws on failure.
   * Optional — the registry will accept the key as-is if absent.
   */
  validate?(config: { apiKey: string; baseUrl?: string }): void | Promise<void>

  /** One-shot chat completion. */
  chat(request: AiChatRequest, config: { apiKey: string; baseUrl?: string; model?: string }): Promise<AiChatResponse>
  /** Streaming chat completion. */
  streamChat(request: AiStreamRequest, config: { apiKey: string; baseUrl?: string; model?: string }): AsyncIterable<AiStreamChunk>
}

// ──────────────────────────────────────────────────────────────────────────────
// Image / analysis plugin (separate concern; one provider can ship both)
// ──────────────────────────────────────────────────────────────────────────────

export interface AiMediaPlugin {
  id: string
  label: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  defaultBaseUrl: string
  imageProtocol?: AiImageProtocol
  imageModels: string[]
  defaultImageModel: string
  analysisProtocol?: AiAnalysisProtocol
  analysisModels: string[]
  defaultAnalysisModel: string
  videoAnalysis: boolean

  generateImage(request: { prompt: string; model?: string; size?: string }, config: { apiKey: string; baseUrl?: string }): Promise<{ url: string; b64?: string; mimeType?: string }>
  analyze?(request: { prompt: string; media: { mimeType: string; data: string }; model?: string }, config: { apiKey: string; baseUrl?: string }): Promise<{ text: string }>
}

export interface AiSearchPlugin {
  id: string
  label: string
  keyPlaceholder?: string
  /** Empty for no-auth providers (DuckDuckGo, etc). */
  search(query: string, config: { apiKey?: string; baseUrl?: string }): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }>
}

// ──────────────────────────────────────────────────────────────────────────────
// Registry
// ──────────────────────────────────────────────────────────────────────────────

export interface ProviderMeta {
  id: string
  label: string
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
}

export interface ProviderRegistry {
  register(plugin: AiProviderPlugin): void
  unregister(id: string): boolean
  /** Returns ids of currently-registered providers (in registration order). */
  list(): string[]
  get(id: string): AiProviderPlugin | undefined
  /** Snapshot of metadata for the UI picker. */
  meta(): ProviderMeta[]
  /** Number of providers registered. */
  size(): number
}

/** Default in-process registry implementation. */
export function createProviderRegistry(): ProviderRegistry {
  const plugins = new Map<string, AiProviderPlugin>()
  return {
    register(plugin) {
      if (!plugin || typeof plugin.id !== 'string' || !plugin.id) {
        throw new Error('AiProviderPlugin: id required')
      }
      if (typeof plugin.chat !== 'function' || typeof plugin.streamChat !== 'function') {
        throw new Error(`AiProviderPlugin "${plugin.id}": chat and streamChat must be functions`)
      }
      plugins.set(plugin.id, plugin)
    },
    unregister(id) {
      return plugins.delete(id)
    },
    list() {
      return [...plugins.keys()]
    },
    get(id) {
      return plugins.get(id)
    },
    meta() {
      return [...plugins.values()].map((p) => ({
        id: p.id,
        label: p.label,
        models: [...p.models],
        defaultModel: p.defaultModel,
        keyPlaceholder: p.keyPlaceholder,
        ...(p.needsBaseUrl ? { needsBaseUrl: p.needsBaseUrl } : {}),
      }))
    },
    size() {
      return plugins.size
    },
  }
}

/**
 * The default shared registry — first-party plugins register themselves at
 * import time via `registerFirstParty()`.
 */
let defaultRegistry: ProviderRegistry | null = null

export function getDefaultProviderRegistry(): ProviderRegistry {
  if (!defaultRegistry) defaultRegistry = createProviderRegistry()
  return defaultRegistry
}

/** For tests: reset the default registry to a fresh empty one. */
export function resetDefaultProviderRegistry(): void {
  defaultRegistry = null
}

// ──────────────────────────────────────────────────────────────────────────────
// Media registry (parallels ProviderRegistry for image/analysis providers)
// ──────────────────────────────────────────────────────────────────────────────

export interface MediaRegistry {
  register(plugin: AiMediaPlugin): void
  unregister(id: string): boolean
  list(): string[]
  get(id: string): AiMediaPlugin | undefined
  size(): number
}

export function createMediaRegistry(): MediaRegistry {
  const plugins = new Map<string, AiMediaPlugin>()
  return {
    register(plugin) {
      if (!plugin || typeof plugin.id !== 'string' || !plugin.id) {
        throw new Error('AiMediaPlugin: id required')
      }
      if (typeof plugin.generateImage !== 'function') {
        throw new Error(`AiMediaPlugin "${plugin.id}": generateImage must be a function`)
      }
      plugins.set(plugin.id, plugin)
    },
    unregister(id) {
      return plugins.delete(id)
    },
    list() {
      return [...plugins.keys()]
    },
    get(id) {
      return plugins.get(id)
    },
    size() {
      return plugins.size
    },
  }
}

export interface SearchRegistry {
  register(plugin: AiSearchPlugin): void
  unregister(id: string): boolean
  list(): string[]
  get(id: string): AiSearchPlugin | undefined
}

export function createSearchRegistry(): SearchRegistry {
  const plugins = new Map<string, AiSearchPlugin>()
  return {
    register(plugin) {
      if (!plugin || typeof plugin.id !== 'string' || !plugin.id) {
        throw new Error('AiSearchPlugin: id required')
      }
      if (typeof plugin.search !== 'function') {
        throw new Error(`AiSearchPlugin "${plugin.id}": search must be a function`)
      }
      plugins.set(plugin.id, plugin)
    },
    unregister(id) {
      return plugins.delete(id)
    },
    list() {
      return [...plugins.keys()]
    },
    get(id) {
      return plugins.get(id)
    },
  }
}
