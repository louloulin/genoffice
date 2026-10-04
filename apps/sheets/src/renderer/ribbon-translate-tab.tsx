/**
 * Sheets binding for the shared standalone translate tab.
 *
 * Same shape as the docs / slides bindings: localize `TranslationRibbonTab`
 * out of the sheets shards, remember the language pair, hand the action back
 * to the App, which routes it into the existing `TranslateSheetDialog`.
 *
 * The one sheets-specific choice is where the caption sits: sheets' ribbon
 * groups are labelled `appGroupLanguage`, so the language caption is reused
 * here rather than inventing a key that exists in one app only.
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
import { t } from './i18n/locale'

const SETTINGS_KEY = 'sheets-translate-tab-settings'

export const DEFAULT_TRANSLATE_SETTINGS: TranslationTabSettings = {
  sourceLanguage: 'auto',
  targetLanguage: 'en-US',
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
      sourceLanguage: String(parsed.sourceLanguage ?? 'auto'),
      targetLanguage: String(parsed.targetLanguage ?? 'en-US'),
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
  const [settings, setSettings] = useState<TranslationTabSettings>(loadTranslateSettings)

  const update = useCallback((patch: Partial<TranslationTabSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* remembering the pair is a nicety, not a gate */
      }
      return next
    })
  }, [])

  const strings: TranslationRibbonTabProps['strings'] = useMemo(
    () => ({
      sourceLanguage: t('aiTranslateSheetSourceLang'),
      targetLanguage: t('aiTranslateTargetLang'),
      swap: t('aiTranslateSheetSwap'),
      languageGroup: t('appGroupLanguage'),
      scopeDocument: t('appTranslate'),
      scopeSelection: t('aiTranslateSheetTitle'),
      bilingual: t('aiTranslateSheetBilingual'),
      preserveFormatting: t('aiTranslateSheetPreserveFormat'),
      memory: t('aiMemoryTab'),
      cancel: t('appCancel'),
      openStorage: t('aiGlossaryPanelTitle'),
      stateIdle: t('appTranslateTitle'),
      stateRunning: t('aiTranslateSheetRunning'),
      stateFailed: t('aiTranslateSheetFailed'),
      stateCancelled: t('appAiStopped'),
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
      showStorage={showStorage}
      onStart={(scope) => onStart(scope, { ...settings, scope })}
      onCancel={onCancel}
      onOpenStorage={onOpenStorage}
    />
  )
}
