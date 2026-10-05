/**
 * Whole-deck translation UI for the slides app.
 *
 * The dialog is the shared, framework-free `TranslateDialog` (same component
 * docs and sheets use) so the interaction is identical across editors: choose
 * languages → run → review every text frame → apply. What this file adds is
 * the slides half — locating the live deck, driving the shared pipeline over
 * the renderer's batch transport, and streaming per-frame progress back to the
 * embedded host as `ai-progress`.
 *
 * Review-then-apply (rather than translate-then-write) is deliberate, and here
 * it is not just a nicety: the pipeline is invoked with a no-op `writeFrame`,
 * so cancelling leaves the deck byte-identical. A slide deck cannot be
 * "roughly undone" the way a spreadsheet can — an accidental write re-runs
 * layout on every touched frame, and PowerPoint's own undo stack is not
 * something this pipeline should be relying on to undo itself.
 *
 * Bilingual mode is applied at write time, not at run time, so toggling the
 * switch while reviewing does not require re-translating: the unit list holds
 * both the source text and the translation either way.
 */

import { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { TranslateDialog, type TranslateLanguageOption } from '@genoffice/ui'
import type {
  TranslateProgress,
  TranslateProgressStatus,
} from '@genoffice/translation-core/document'
import { emitTranslateProgress } from './translate-progress'

import { t } from '../i18n/locale'
import {
  composeFrameText,
  parseDeckUnitId,
  translateDeckDocument,
  type DeckTranslateBatchFn,
  type DeckTranslateWrite,
  type SlideLike,
} from './document-translate'

/**
 * Narrow the pipeline's progress vocabulary to the host's (markdown/html/docs
 * parity). `completed-with-failures` is the pipeline's partial-success terminal
 * state and the host's `ai-progress` cannot render it: reporting it as
 * `completed` would tell the host the deck translated cleanly when part of it
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

export interface DeckTranslateRequest {
  scope: 'selection' | 'document'
  sourceLanguage?: string
  targetLanguage: string
  bilingual?: boolean
  preserveFormatting?: boolean
  memoryEnabled?: boolean
  qualityCheck?: boolean
  glossaryCategory?: string
}

export interface TranslateDeckDialogHandle {
  /** Open the dialog, optionally pre-filled from a host `translate` command. */
  open(request?: Partial<DeckTranslateRequest>): void
  close(): void
}

export interface TranslateDeckDialogProps {
  /** The live deck at call time — a getter, because the deck loads async. */
  getSlides: () => readonly SlideLike[] | null
  /** Write settled translations back. Only called from the dialog's Apply. */
  onApply: (writes: readonly DeckTranslateWrite[]) => void
  /** Batch transport; falls back to the non-streaming call when absent. */
  translateBatch: DeckTranslateBatchFn
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

export function TranslateDeckDialog(
  props: TranslateDeckDialogProps & { ref?: React.Ref<TranslateDeckDialogHandle> },
): React.JSX.Element {
  const { getSlides, onApply, translateBatch, defaultTargetLang = 'zh-CN' } = props
  const [open, setOpen] = useState(false)
  // Languages delivered by a host `translate` command. Cleared on every open()
  // without a request so a manual open falls back to the UI-language pair.
  const [initialLangs, setInitialLangs] = useState<{ source?: string; target?: string }>({})
  const [bilingual, setBilingual] = useState(false)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [quality, setQuality] = useState<
    { overallScore?: number; warnings?: string[] } | undefined
  >()
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const latestRef = useRef<Array<{ unitId: string; sourceText: string; translatedText: string }>>(
    [],
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  useImperativeHandle(
    props.ref,
    (): TranslateDeckDialogHandle => ({
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
    async (args: { sourceLang: string; targetLang: string }): Promise<string | null> => {
      const slides = getSlides()
      if (!slides || slides.length === 0) {
        setError(t('aiTranslateDeckNoText'))
        return null
      }
      setError(null)
      cancel()
      const controller = new AbortController()
      abortRef.current = controller
      const preview = new Map<string, PreviewRow>()
      const toRow = (unit: {
        unitId: string
        sourceText: string
        translatedText?: string
        status?: string
        warnings?: string[]
        matchedTerms?: string[]
      }): PreviewRow => ({
        id: unit.unitId,
        sourceText: unit.sourceText,
        ...(unit.translatedText !== undefined ? { translatedText: unit.translatedText } : {}),
        ...(unit.status !== undefined ? { status: unit.status } : {}),
        ...(unit.warnings ? { warnings: unit.warnings } : {}),
        ...(unit.matchedTerms ? { matchedTerms: unit.matchedTerms } : {}),
      })
      try {
        const run = await translateDeckDocument(
          {
            slides,
            translateBatch: (request, signal, onUnit) =>
              translateBatch(request, signal ?? controller.signal, (unit) => {
                onUnit?.(unit)
                preview.set(unit.unitId, toRow(unit))
                setRows([...preview.values()])
              }),
            onProgress,
            // The dialog's Apply performs the write, so the pipeline's own
            // apply step is a no-op here — the deck is untouched until then.
            writeFrame: async () => {},
          },
          {
            targetLang: args.targetLang,
            sourceLang: args.sourceLang,
            // Bilingual is composed at write time from the reviewed units, so
            // the run itself always translates plain text.
            applyMode: 'replace',
            signal: controller.signal,
          },
        )
        abortRef.current = null
        if (run.status === 'cancelled') return null
        if (run.status === 'failed') {
          setError(run.error ?? t('aiTranslateDeckFailed'))
          return null
        }
        if (run.units.length === 0) {
          setError(t('aiTranslateDeckNoText'))
          return null
        }
        setQuality(run.quality)
        setRows(run.units.map(toRow))
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
    [cancel, getSlides, onProgress, translateBatch],
  )

  const strings = useMemo(
    () => ({
      title: t('aiTranslateDeckTitle'),
      targetLang: t('aiTranslateTargetLang'),
      sourceLang: t('aiTranslateDeckSourceLang'),
      preserveFormat: t('aiTranslateDeckPreserveFormat'),
      bilingual: t('aiTranslateDeckBilingual'),
      swapLanguages: t('aiTranslateDeckSwap'),
      start: t('aiTranslateDeckStart'),
      apply: t('aiTranslateDeckApply'),
      original: t('aiTranslateDeckOriginal'),
      translated: t('aiTranslateDeckTranslated'),
      previewTitle: t('aiTranslateDeckTitle'),
      previewLoading: t('aiTranslateDeckRunning'),
      cancel: t('ribbonCancel'),
      unsupported: t('aiTranslateDeckSkipNote'),
    }),
    [],
  )

  return (
    <TranslateDialog
      open={open}
      // The dialog requires a source text; the real per-frame list arrives
      // through `previewItems` once the run starts, and a deck has no single
      // "document text" to show before that.
      sourceText=""
      hasTranslatableContent={(getSlides() ?? []).length > 0}
      defaultTargetLang={defaultTargetLang}
      initialSourceLang={initialLangs.source}
      initialTargetLang={initialLangs.target}
      languages={[...TRANSLATE_LANGS]}
      strings={strings}
      previewItems={rows}
      {...(quality ? { previewQuality: quality } : {})}
      bilingual={bilingual}
      onBilingualChange={setBilingual}
      app="slides"
      onTranslate={handleTranslate}
      onApply={() => {
        const mode = bilingual ? 'bilingual' : 'replace'
        // A unit whose id we cannot parse is dropped, not guessed at: writing a
        // translation to the wrong text frame is worse than skipping one.
        const writes = latestRef.current.flatMap((unit) => {
          const address = parseDeckUnitId(unit.unitId)
          if (!address) return []
          return [
            { ...address, text: composeFrameText(unit.sourceText, unit.translatedText, mode) },
          ]
        })
        onApply(writes)
        setOpen(false)
      }}
      onCancel={() => {
        cancel()
        setOpen(false)
      }}
    />
  )
}
