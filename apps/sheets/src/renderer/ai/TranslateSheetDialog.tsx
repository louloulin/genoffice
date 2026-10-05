/**
 * Whole-worksheet translation UI for the sheets app.
 *
 * The dialog itself is the shared, framework-free `TranslateDialog` (same
 * component docs uses) so the interaction is identical across editors: choose
 * languages → run → review each cell → apply. What this file adds is the
 * sheets half: extracting the active sheet, driving the shared pipeline with
 * the renderer's batch transport, and streaming per-cell progress back to the
 * embedded host as `ai-progress`.
 *
 * Review-then-apply (rather than translate-then-write) is deliberate: the
 * shared pipeline is invoked with a no-op `apply`, and the write only happens
 * from `onApply`. A user who cancels therefore leaves the workbook untouched —
 * the alternative (write as you go, then "undo") cannot be undone correctly
 * once a bilingual run has inserted a whole column of new cells.
 */

import { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import {
  TranslateDialog,
  type TranslateLanguageOption,
} from '@genoffice/ui'
import type { TranslateProgress, TranslateProgressStatus } from '@genoffice/translation-core/document'
import { emitTranslateProgress } from '../translate-progress'

import { t } from '../i18n/locale'
import {
  translateSheetDocument,
  type SheetTranslateBatchFn,
  type SheetTranslateWorksheet,
} from './document-translate'

/**
 * Narrow the pipeline's progress vocabulary to the host's (markdown/html/docs
 * parity). `completed-with-failures` is the pipeline's partial-success terminal
 * state and the host's `ai-progress` cannot render it: reporting it as
 * `completed` would tell the host the sheet translated cleanly when part of it
 * was left in the source language, so it is reported as `failed` — the honest
 * direction to be wrong in.
 */
function hostProgressStatus(
  status: TranslateProgressStatus,
): 'started' | 'running' | 'completed' | 'failed' | 'cancelled' {
  if (status === 'started' || status === 'running' || status === 'completed') return status
  if (status === 'cancelled') return 'cancelled'
  return 'failed'
}

const TRANSLATE_LANGS: readonly TranslateLanguageOption[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en-US', label: 'English' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
  { value: 'fr-FR', label: 'Français' },
  { value: 'de-DE', label: 'Deutsch' },
  { value: 'es-ES', label: 'Español' },
  { value: 'it-IT', label: 'Italiano' },
  { value: 'pt-PT', label: 'Português' },
  { value: 'ru-RU', label: 'Русский' },
  { value: 'ar-SA', label: 'العربية' },
]

export interface SheetTranslateRequest {
  scope: 'selection' | 'document'
  sourceLanguage?: string
  targetLanguage: string
  bilingual?: boolean
  preserveFormatting?: boolean
  memoryEnabled?: boolean
  qualityCheck?: boolean
  glossaryCategory?: string
}

export interface TranslateSheetDialogHandle {
  /** Open the dialog, optionally pre-filled from a host `translate` command. */
  open(request?: Partial<SheetTranslateRequest>): void
  close(): void
}

export interface TranslateSheetDialogProps {
  /** The live sheet at call time — a ref, because the workbook loads async. */
  getSheet: () => SheetTranslateWorksheet | null
  /** Write settled translations back. Only called from the dialog's Apply. */
  onApply: (args: { units: Array<{ unitId: string; sourceText: string; translatedText: string }>; bilingual: boolean }) => void
  /** Batch transport; falls back to the non-streaming call when absent. */
  translateBatch: SheetTranslateBatchFn
  defaultTargetLang?: string
}

interface PreviewRow {
  id: string
  sourceText: string
  translatedText?: string
  status?: string
  warnings?: string[]
  matchedTerms?: string[]
}

export function TranslateSheetDialog(
  props: TranslateSheetDialogProps & { ref?: React.Ref<TranslateSheetDialogHandle> },
): React.JSX.Element {
  const { getSheet, onApply, translateBatch, defaultTargetLang = 'zh-CN' } = props
  const [open, setOpen] = useState(false)
  // Languages delivered by a host `translate` command. Cleared on every open()
  // without a request so a manual open falls back to the UI-language default.
  const [initialLangs, setInitialLangs] = useState<{ source?: string; target?: string }>({})
  const [bilingual, setBilingual] = useState(false)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [quality, setQuality] = useState<{ overallScore?: number; warnings?: string[] } | undefined>()
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const latestRef = useRef<Array<{ unitId: string; sourceText: string; translatedText: string }>>([])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  useImperativeHandle(
    props.ref,
    (): TranslateSheetDialogHandle => ({
      open(request) {
        // A fresh command must not inherit the previous run's verdict.
        setRows([])
        setQuality(undefined)
        setError(null)
        setBilingual(request?.bilingual === true)
        setInitialLangs({
          ...(request?.sourceLanguage ? { source: request.sourceLanguage } : {}),
          ...(request?.targetLanguage ? { target: request.targetLanguage } : {}),
        })
        setOpen(true)
      },
      close() {
        cancel()
        setOpen(false)
      },
    }),
    [cancel],
  )

  const onProgress = useCallback((event: TranslateProgress) => {
    // `exactOptionalPropertyTypes` is on: an absent count must be *absent*,
    // not present-and-undefined, or the host renders "undefined/undefined".
    emitTranslateProgress({
      type: 'ai-progress',
      status: hostProgressStatus(event.status),
      progress: event.progress,
      ...(event.completedUnits !== undefined ? { completedUnits: event.completedUnits } : {}),
      ...(event.totalUnits !== undefined ? { totalUnits: event.totalUnits } : {}),
      ...(event.quality ? { quality: event.quality } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    })
  }, [])

  const handleTranslate = useCallback(
    async (args: { sourceLang: string; targetLang: string; preserveFormat: boolean }): Promise<string | null> => {
      const sheet = getSheet()
      if (!sheet) {
        setError(t('appWorkbookNotReady'))
        return null
      }
      setError(null)
      cancel()
      const controller = new AbortController()
      abortRef.current = controller
      const preview = new Map<string, PreviewRow>()
      try {
        const run = await translateSheetDocument(
          {
            sheet,
            translateBatch: (request, signal, onUnit) =>
              translateBatch(request, signal ?? controller.signal, (unit) => {
                onUnit?.(unit)
                preview.set(unit.unitId, {
                  id: unit.unitId,
                  sourceText: unit.sourceText,
                  ...(unit.translatedText !== undefined ? { translatedText: unit.translatedText } : {}),
                  ...(unit.status !== undefined ? { status: unit.status } : {}),
                  ...(unit.warnings ? { warnings: unit.warnings } : {}),
                  ...(unit.matchedTerms ? { matchedTerms: unit.matchedTerms } : {}),
                })
                setRows([...preview.values()])
              }),
            onProgress,
            // The dialog's Apply performs the write, so the pipeline's own
            // apply step is intentionally a no-op here. It belongs on the
            // adapters (first argument), not on the request options.
            apply: () => {},
          },
          {
            targetLang: args.targetLang,
            sourceLang: args.sourceLang,
            preserveFormat: args.preserveFormat,
            signal: controller.signal,
          },
        )
        abortRef.current = null
        if (run.status === 'cancelled') return null
        if (run.status === 'failed') {
          setError(run.error ?? t('aiTranslateSheetFailed'))
          return null
        }
        setQuality(run.quality)
        setRows(
          run.units.map((unit) => ({
            id: unit.unitId,
            sourceText: unit.sourceText,
            ...(unit.translatedText !== undefined ? { translatedText: unit.translatedText } : {}),
            ...(unit.status !== undefined ? { status: unit.status } : {}),
            ...(unit.warnings ? { warnings: unit.warnings } : {}),
            ...(unit.matchedTerms ? { matchedTerms: unit.matchedTerms } : {}),
          })),
        )
        latestRef.current = run.units.map((unit) => ({
          unitId: unit.unitId,
          sourceText: unit.sourceText,
          translatedText: unit.translatedText,
        }))
        return run.units.map((unit) => unit.translatedText).join('\n')
      } catch (caught) {
        abortRef.current = null
        setError(caught instanceof Error ? caught.message : String(caught))
        return null
      }
    },
    [cancel, getSheet, onProgress, translateBatch],
  )

  const strings = useMemo(
    () => ({
      title: t('aiTranslateSheetTitle'),
      targetLang: t('aiTranslateTargetLang'),
      sourceLang: t('aiTranslateSheetSourceLang'),
      preserveFormat: t('aiTranslateSheetPreserveFormat'),
      bilingual: t('aiTranslateSheetBilingual'),
      swapLanguages: t('aiTranslateSheetSwap'),
      start: t('aiTranslateBtn'),
      apply: t('aiTranslateApply'),
      original: t('aiTranslateSheetOriginal'),
      translated: t('aiTranslateSheetTranslated'),
      previewTitle: t('aiTranslateSheetTitle'),
      previewLoading: t('aiTranslateSheetRunning'),
      cancel: t('dlgCancel'),
      unsupported: t('aiTranslateSheetNoText'),
    }),
    [],
  )

  return (
    <TranslateDialog
      open={open}
      // The dialog requires a source text; the real unit list arrives through
      // `previewItems` once the run starts, and the sheet has no single
      // "document text" to show before that.
      sourceText=""
      hasTranslatableContent={getSheet() !== null}
      defaultTargetLang={defaultTargetLang}
      initialSourceLang={initialLangs.source}
      initialTargetLang={initialLangs.target}
      languages={[...TRANSLATE_LANGS]}
      strings={strings}
      previewItems={rows}
      {...(quality ? { previewQuality: quality } : {})}
      bilingual={bilingual}
      onBilingualChange={setBilingual}
      app="sheets"
      onTranslate={handleTranslate}
      onApply={() => {
        onApply({ units: latestRef.current, bilingual })
        setOpen(false)
      }}
      onCancel={() => {
        cancel()
        setOpen(false)
      }}
    />
  )
}
