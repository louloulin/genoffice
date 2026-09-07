/**
 * ai/settings — Shared AI settings state + channel registration.
 *
 * Phase 1.3 (LUM-555): the legacy { provider, model, temperature, ... }
 * shape is replaced by @genoffice/ai-provider's `AiSettings` (multi-provider
 * config with per-provider api keys). Default provider is `minimax` so the
 * existing MINIMAX_API_KEY / MINIMAX_BASE_URL env vars wire up directly via
 * provider.ts's resolveEnvSettings().
 */

import {
  AI_PROVIDERS,
  defaultAiSettings,
  type AiProviderId,
  type AiSettings,
} from '@genoffice/ai-provider'
import { registerHandle } from '../common/registry.js'

export type { AiProviderId, AiSettings }

/**
 * Web-server default: route through MiniMax-M3. apiKey/baseUrl are
 * intentionally left empty — provider.ts's resolveEnvSettings() reads
 * MINIMAX_API_KEY / MINIMAX_BASE_URL at call time, so secrets never enter
 * this module.
 */
function buildDefaultSettings(): AiSettings {
  const settings = defaultAiSettings()
  settings.provider = 'minimax'
  settings.providers.minimax = {
    apiKey: '',
    model: 'MiniMax-M3',
  }
  // Make sure every provider has its defaultModel so a future switch
  // without an explicit model still resolves to something usable.
  for (const meta of AI_PROVIDERS) {
    if (!settings.providers[meta.id]) {
      settings.providers[meta.id] = { apiKey: '', model: meta.defaultModel }
    } else if (!settings.providers[meta.id].model) {
      settings.providers[meta.id].model = meta.defaultModel
    }
  }
  return settings
}

export const aiSettings: { settings: AiSettings } = {
  settings: buildDefaultSettings(),
}

export function registerAiSettingsHandlers(): void {
  registerHandle('ai:get-settings', () => aiSettings.settings)
  registerHandle('ai:set-settings', (_event: unknown, settings: unknown) => {
    // Accept the AiSettings shape only; legacy field shapes are dropped.
    // Tolerant of bad input: missing/non-object payload is a no-op (matches
    // the pre-Phase-1.3 behavior of `Object.assign(aiSettings, undefined)`).
    if (!settings || typeof settings !== 'object') return { ok: true }
    const next = settings as Partial<AiSettings>
    if (typeof next.provider === 'string') aiSettings.settings.provider = next.provider as AiProviderId
    if (next.providers && typeof next.providers === 'object') {
      aiSettings.settings.providers = {
        ...aiSettings.settings.providers,
        ...next.providers,
      }
    }
    if (typeof next.gskToolsEnabled === 'boolean') {
      aiSettings.settings.gskToolsEnabled = next.gskToolsEnabled
    }
    return { ok: true }
  })
  registerHandle('ai:gsk-login', () => ({
    loggedIn: true,
    email: 'web-user@genoffice.ai',
    credits: 1000,
  }))
  registerHandle('ai:log-run-failure', () => ({ ok: true }))
}
