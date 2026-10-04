/**
 * Slides binding for the shared standalone translate tab.
 *
 * Mirrors the docs binding: localizes `TranslationRibbonTab` out of the
 * slides shards, owns the per-session settings, and hands the action back to
 * the App. The App routes it into the existing `TranslateDeckDialog` — the
 * same dialog the host `translate` command opens — so there is exactly one
 * deck-translation pipeline and the tab is a facade, not a second one.
 *
 * The language pair is remembered per app in `localStorage`: every mainstream
 * translation product keeps the last pair, and re-picking "Chinese → English"
 * on each document is the single most common complaint about editors that
 * forget it.
 */
import { useCallback, useMemo, useState } from 'react'
// Subpath import, not the bare entry: `translation-core`'s index re-exports
// modules that pull in Node built-ins (fs / child_process), which a renderer
// bundle cannot resolve.
import { LANGUAGES, targetLanguageChoices } from '@genoffice/translation-core/languages'
import {
  TranslationRibbonTab,
  type TranslationLanguageChoice,
  type TranslationRibbonTabProps,
  type TranslationScope,
  type TranslationTabSettings,
  type TranslationTabStatus,
} from '@genoffice/ui'
import { t } from '../i18n/locale'

const SETTINGS_KEY = 'slides-translate-tab-settings'

export const DEFAULT_TRANSLATE_SETTINGS: TranslationTabSettings = {
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  scope: 'document',
  bilingual: false,
  preserveFormatting: true,
  memoryEnabled: true,
  qualityCheck: true,
}

/** Last pair this user picked, or the defaults when nothing is stored. */
export function loadTranslateSettings(): TranslationTabSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return DEFAULT_TRANSLATE_SETTINGS
    const parsed = JSON.parse(raw) as Partial<TranslationTabSettings>
    return {
      ...DEFAULT_TRANSLATE_SETTINGS,
      ...parsed,
      // A stored value from an older build could name a language this build no
      // longer offers; falling back keeps the select from rendering blank.
      sourceLanguage: String(parsed.sourceLanguage ?? 'auto'),
      targetLanguage: String(parsed.targetLanguage ?? 'zh-CN'),
      scope: 'document',
    }
  } catch {
    return DEFAULT_TRANSLATE_SETTINGS
  }
}

const CHOICES: TranslationLanguageChoice[] = LANGUAGES.map((lang) => ({
  value: lang.value,
  label: lang.label,
}))

export interface TranslateTabProps {
  hasDoc: boolean
  status: TranslationTabStatus
  showStorage: boolean
  onStart: (scope: TranslationScope, settings: TranslationTabSettings) => void
  onCancel: () => void
  onOpenStorage: () => void
}

export function TranslateTab({
  hasDoc,
  status,
  showStorage,
  onStart,
  onCancel,
  onOpenStorage,
}: TranslateTabProps) {
  // Seed from the remembered pair once; later changes are written back below.
  const [settings, setSettings] = useState<TranslationTabSettings>(loadTranslateSettings)

  const update = useCallback((patch: Partial<TranslationTabSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* private mode / quota — remembering the pair is a nicety, not a gate */
      }
      return next
    })
  }, [])

  const strings: TranslationRibbonTabProps['strings'] = useMemo(
    () => ({
      sourceLanguage: t('aiTranslateDeckSourceLang'),
      targetLanguage: t('aiTranslateTargetLang'),
      swap: t('aiTranslateDeckSwap'),
      // No group captions: the selects are labelled individually and the band
      // stays short in a ribbon that already carries nine tabs.
      scopeDocument: t('aiChipTranslate'),
      scopeSelection: t('aiTranslateDeckTitle'),
      bilingual: t('aiTranslateDeckBilingual'),
      preserveFormatting: t('aiTranslateDeckPreserveFormat'),
      memory: t('aiMemoryTab'),
      cancel: t('ribbonCancel'),
      openStorage: t('aiGlossaryPanelTitle'),
      stateIdle: t('ribbonTranslateTip'),
      stateRunning: t('aiTranslateDeckRunning'),
      stateFailed: t('aiTranslateDeckFailed'),
      stateCancelled: t('aiStoppedNote'),
      units: '{done}/{total}',
      qualityBadge: '{score}%',
    }),
    [],
  )

  return (
    <TranslationRibbonTab
      strings={strings}
      languages={targetLanguageChoices()}
      sourceLanguages={CHOICES}
      settings={settings}
      onSettingsChange={update}
      status={status}
      disabled={!hasDoc}
      // The deck pipeline translates the whole presentation; there is no
      // selection-scoped run to offer, so the button is not rendered at all
      // rather than rendered and inert.
      allowSelection={false}
      showStorage={showStorage}
      onStart={(scope) => onStart(scope, { ...settings, scope })}
      onCancel={onCancel}
      onOpenStorage={onOpenStorage}
    />
  )
}
