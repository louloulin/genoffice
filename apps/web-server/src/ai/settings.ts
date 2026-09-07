/**
 * ai/settings — Shared AI settings state + channel registration.
 */

import { registerHandle } from '../common/registry.js'

export interface AiSettings {
  provider: string
  model: string
  temperature: number
  maxTokens: number
  streaming: boolean
}

export const aiSettings: AiSettings = {
  provider: 'genspark',
  model: 'auto',
  temperature: 0.7,
  maxTokens: 4096,
  streaming: true,
}

export function registerAiSettingsHandlers(): void {
  registerHandle('ai:get-settings', () => aiSettings)
  registerHandle('ai:set-settings', (_event: unknown, settings: unknown) => {
    Object.assign(aiSettings, settings as Partial<AiSettings>)
    return { ok: true }
  })
  registerHandle('ai:gsk-login', () => ({
    loggedIn: true,
    email: 'web-user@genoffice.ai',
    credits: 1000,
  }))
  registerHandle('ai:log-run-failure', () => ({ ok: true }))
}
