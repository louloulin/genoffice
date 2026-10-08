/**
 * app:* preference channels plus M0 stubs for every channel the docs
 * renderer touches on boot. Stubs answer with the "unsupported" shape the
 * renderer already tolerates (web-server parity): a channel may degrade but
 * must never 404 — an unregistered channel throws IpcBridgeError at call
 * time and surfaces as an unhandled rejection.
 */
import type { Registry } from '../registry'
import type { AiSettings } from '@genoffice/ai-provider'
import { redactAiSettings, resolveAiHostSettings } from '../ai-settings'
import { OfficeError } from '../../errors'

type AutoSaveDefault = { on: boolean; updatedAt: number }
type AiFontSize = 'default' | 'large' | 'xlarge' | 'custom'
type AiPanelPrefs = { fontSize: AiFontSize; customFontSize: number; spellcheck: boolean }

export interface AppChannelState {
  language: string
  theme: 'light' | 'dark' | 'system'
  autoSave: AutoSaveDefault
  aiPanel: AiPanelPrefs
}

const DEFAULT_STATE: AppChannelState = {
  language: 'zh',
  theme: 'light',
  autoSave: { on: false, updatedAt: 0 },
  aiPanel: { fontSize: 'default', customFontSize: 14, spellcheck: true },
}

function notConfigured(channel: string): never {
  throw new OfficeError('OFFICE_NEEDS_APP', `${channel} is not available in the office-ai UI host`)
}

/** Channels that answer a canned "not supported / empty" shape. */
const STUB_CHANNELS: Record<string, (args: unknown[]) => unknown> = {
  'ai:chat': () => notConfigured('ai:chat'),
  'ai:stream': () => notConfigured('ai:stream'),
  'ai:stream-cancel': () => ({ ok: true }),
  'ai:fetch-image': () => null,
  'ai:gsk-login': () => notConfigured('ai:gsk-login'),
  'ai:gsk-status': () => ({ signedIn: false }),
  'ai:image-search': () => [],
  'ai:save-translation-memory': () => ({ ok: false }),
  'ai:set-settings': () => ({ ok: true }),
  'ai:translate': () => notConfigured('ai:translate'),
  'ai:translate-batch': () => notConfigured('ai:translate-batch'),
  'ai:web-search': () => [],
  // docs.ts, sheets.ts, slides.ts and pdf.ts register the format channels;
  // only genuinely-unsupported leftovers stay here.
  'docs:print-pdf-buffer': () => ({ ok: false, error: 'unsupported' }),
  'files:add': () => [],
  'files:pick': () => ({ canceled: true, paths: [] }),
  'files:read-image': () => null,
  'project:appendChat': () => ({ ok: false, error: 'unsupported' }),
  'project:create': () => null,
  'project:delete': () => ({ ok: false, error: 'unsupported' }),
  'project:list': () => [],
  'project:loadChat': () => null,
  'project:moveFile': () => ({ ok: false, error: 'unsupported' }),
  'project:rebindChat': () => ({ ok: false, error: 'unsupported' }),
  'project:rename': () => ({ ok: false, error: 'unsupported' }),
  'project:resolveChat': () => null,
  'project:timeline': () => [],
  'win:focus': () => ({ ok: false, error: 'Window not found' }),
  'win:list': () => [],
  'win:new': () => ({ id: 'win-0', url: '/' }),
}

export function registerAppChannels(
  registry: Registry,
  /** Already resolved by the host from its `ai` option; unconfigured by default. */
  ai: AiSettings = resolveAiHostSettings(undefined),
  state: AppChannelState = { ...DEFAULT_STATE },
): AppChannelState {
  // provider/model are truthful so the panel can label the active model; every
  // apiKey is blanked — this channel reaches the browser, and the real key
  // stays host-side where `/api/ai/stream` uses it.
  registry.registerHandle('ai:get-settings', () => redactAiSettings(ai))

  registry.registerHandle('app:get-language', () => state.language)
  registry.registerHandle('app:get-theme', () => state.theme)
  registry.registerHandle('app:get-version', () => '0.1.0')
  registry.registerHandle('app:get-platform', () => 'web')
  registry.registerHandle('app:get-auto-save-default', () => ({ ...state.autoSave }))
  registry.registerHandle('app:set-auto-save-default', (_event, value: unknown) => {
    const v = value as Partial<AutoSaveDefault> | undefined
    if (typeof v?.on !== 'boolean') return { ok: false, error: 'invalid AutoSaveDefault payload' }
    state.autoSave = { on: v.on, updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : Date.now() }
    return { ok: true }
  })
  registry.registerHandle('app:get-ai-panel-prefs', () => ({ ...state.aiPanel }))
  registry.registerHandle('app:set-ai-panel-prefs', (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') return { ok: false, error: 'invalid AiPanelPrefs payload' }
    const next = { ...state.aiPanel, ...(patch as Partial<AiPanelPrefs>) }
    if (!['default', 'large', 'xlarge', 'custom'].includes(next.fontSize)) {
      return { ok: false, error: 'invalid AiPanelPrefs payload' }
    }
    state.aiPanel = next
    return { ok: true, prefs: { ...state.aiPanel } }
  })

  for (const [channel, stub] of Object.entries(STUB_CHANNELS)) {
    registry.registerHandle(channel, (_event, ...args) => stub(args))
  }
  return state
}