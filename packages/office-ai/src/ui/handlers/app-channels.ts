/**
 * app:* preference channels plus M0 stubs for every channel the docs
 * renderer touches on boot. Stubs answer with the "unsupported" shape the
 * renderer already tolerates (web-server parity): a channel may degrade but
 * must never 404 — an unregistered channel throws IpcBridgeError at call
 * time and surfaces as an unhandled rejection.
 */
import type { Registry } from '../registry'
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
  'ai:get-settings': () => ({
    // Signed-out genspark default: the renderer treats it as "AI not
    // configured" without crashing on missing provider configs.
    provider: 'genspark',
    providers: {},
    gskToolsEnabled: false,
  }),
  'ai:image-search': () => [],
  'ai:save-translation-memory': () => ({ ok: false }),
  'ai:set-settings': () => ({ ok: true }),
  'ai:translate': () => notConfigured('ai:translate'),
  'ai:translate-batch': () => notConfigured('ai:translate-batch'),
  'ai:web-search': () => [],
  'docs:ai-generate-image': () => ({ ok: false, error: 'ai-not-configured' }),
  'docs:consume-ai-doc-content': () => null,
  'docs:consume-new-blank': () => null,
  'docs:consume-pending-open': () => null,
  'docs:copy-image-to-clipboard': () => ({ ok: false, error: 'clipboard-unavailable' }),
  'docs:create-document': () => ({ ok: false, error: 'unsupported' }),
  'docs:discard-password-intents': () => ({ ok: true }),
  'docs:export-pdf': () => ({ ok: false, error: 'unsupported' }),
  'docs:font-metrics': (args) => ({
    family: (args[0] as string) || 'sans-serif',
    ascent: 0.8,
    descent: 0.2,
    lineGap: 0.1,
    unitsPerEm: 1000,
  }),
  'docs:open': () => ({ ok: false, error: 'unsupported' }),
  'docs:open-decrypt': () => ({ ok: false, error: 'unsupported' }),
  'docs:open-path': () => ({ ok: false, error: 'unsupported' }),
  'docs:password-intent-revision': () => 0,
  'docs:pick-image': () => ({ canceled: true, dataUrl: null }),
  'docs:print': () => ({ ok: false, error: 'unsupported' }),
  'docs:print-pdf-buffer': () => ({ ok: false, error: 'unsupported' }),
  'docs:recent': () => [],
  'docs:respell-kick': () => ({ ok: true, supported: false }),
  'docs:save': () => ({ ok: false, error: 'unsupported' }),
  'docs:save-as': () => ({ ok: false, error: 'unsupported' }),
  'docs:save-merged-pdf': () => ({ ok: false, error: 'unsupported' }),
  'docs:save-new': () => ({ ok: false, error: 'unsupported' }),
  'docs:set-password': () => ({ ok: false, error: 'unsupported' }),
  'docs:view-menu-state': () => ({ ok: true }),
  'docs:write-recovery': () => ({ ok: false, error: 'unsupported' }),
  'files:add': () => [],
  'files:add-pasted-image': () => null,
  'files:pick': () => ({ canceled: true, paths: [] }),
  'files:read': () => ({ ok: false, error: 'unsupported' }),
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

export function registerAppChannels(registry: Registry, state: AppChannelState = { ...DEFAULT_STATE }): AppChannelState {
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