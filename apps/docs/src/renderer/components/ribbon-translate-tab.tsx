/**
 * Docs binding for the shared standalone translate tab.
 *
 * Localizes `TranslationRibbonTab` out of the docs shards (ribbon + ai) and
 * owns the per-session settings. The heavy lifting stays in AiPanel: pressing
 * either action funnels into the same `dataflare:open-translate` channel the
 * Dataflare host already uses, so there is exactly one translate pipeline.
 */
import { useMemo, useState } from 'react'
import { LANGUAGES } from '@genoffice/translation-core'
import {
  TranslationRibbonTab,
  type TranslationLanguageChoice,
  type TranslationRibbonTabProps,
  type TranslationScope,
  type TranslationTabSettings,
  type TranslationTabStatus,
} from '@genoffice/ui'
import { t } from '../i18n/locale'

export const DEFAULT_TRANSLATE_SETTINGS: TranslationTabSettings = {
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  scope: 'document',
  bilingual: false,
  preserveFormatting: true,
  memoryEnabled: true,
  qualityCheck: true,
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
  const [settings, setSettings] = useState<TranslationTabSettings>(DEFAULT_TRANSLATE_SETTINGS)

  const strings: TranslationRibbonTabProps['strings'] = useMemo(
    () => ({
      sourceLanguage: t('aiTranslateSourceLang'),
      targetLanguage: t('aiTranslateTargetLang'),
      swap: t('aiTranslateSwapLanguages'),
      languageGroup: t('ribbonGroupLanguage'),
      optionsGroup: t('ribbonAiCreditNote'),
      actionGroup: t('ribbonTranslateTip'),
      scopeDocument: t('aiChipTranslate'),
      scopeSelection: t('aiTranslateDialogTitle'),
      bilingual: t('aiTranslateBilingual'),
      preserveFormatting: t('aiTranslatePreserveFormat'),
      memory: t('aiMemoryTab'),
      cancel: t('aiTranslateCancel'),
      openStorage: t('aiGlossaryPanelTitle'),
      stateIdle: t('ribbonTranslateTip'),
      stateRunning: t('aiTranslatePreviewLoading'),
      // Completed / cancelled carry no dedicated key yet; the 100% bar and
      // the stopped dot already say it, so we leave the text empty instead of
      // inventing a string that would need 20 locale shards.
      stateCompleted: '',
      stateFailed: t('aiTranslateUnsupported'),
      stateCancelled: t('aiStopped'),
      units: '{done}/{total}',
      qualityBadge: '{score}%',
    }),
    [],
  )

  return (
    <TranslationRibbonTab
      strings={strings}
      languages={CHOICES.filter((c) => c.value !== 'auto')}
      sourceLanguages={CHOICES}
      settings={settings}
      onSettingsChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
      status={status}
      disabled={!hasDoc}
      onStart={(scope) => onStart(scope, { ...settings, scope })}
      onCancel={onCancel}
      onOpenStorage={onOpenStorage}
      showStorage={showStorage}
    />
  )
}
