/**
 * Whole-document translation UI for the pdf app.
 *
 * The dialog is the shared, framework-free `TranslateDialog` (the same
 * component docs / sheets / slides use) so the interaction is identical across
 * editors: choose languages → run → review every paragraph → apply. What this
 * file adds is the pdf half — reaching the live document's text layer, driving
 * the shared pipeline over the renderer's batch transport, and streaming
 * per-paragraph progress back to the embedded host as `ai-progress`.
 *
 * Review-then-apply is not a nicety here either: the pipeline runs with a
 * no-op `apply`, so cancelling leaves the PDF byte-identical. The alternative
 * — writing pending edits as each batch settles — would leave a document the
 * user believes they cancelled in a half-translated state, and a PDF's undo is
 * whatever `textEdits` history happens to hold, not a document-level undo.
 *
 * Bilingual is applied at write time, not run time, so toggling the switch
 * while reviewing does not require re-translating.
 */

import { useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { TranslateDialog, type TranslateLanguageOption } from '@genoffice/ui'
import type {
  TranslateBatchFn,
  TranslateProgress,
  TranslatedUnit,
} from '@genoffice/translation-core/document'
import { emitTranslateProgress } from '../translate-progress'

import { t } from '../i18n/locale'
import type { PageEntry } from '../search'
import {
  applyPdfTranslations,
  translatePdfDocument,
  type PdfTextBlock,
  type PdfTranslationPlan,
} from './document-translate'

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

export interface PdfTranslateRequest {
  scope: 'selection' | 'document'
  sourceLanguage?: string
  targetLanguage: string
  bilingual?: boolean
  preserveFormatting?: boolean
  memoryEnabled?: boolean
  qualityCheck?: boolean
  glossaryCategory?: string
}

export interface TranslatePdfDialogHandle {
  /** Open the dialog, optionally pre-filled from a host `translate` command. */
  open(request?: Partial<PdfTranslateRequest>): void
  close(): void
}

export interface TranslatePdfDialogProps {
  /**
   * The live document's per-page text index at call time — a getter returning a
   * promise, because the index is built (and OCR pages merged in) lazily by the
   * App rather than held in renderer state.
   */
  getSearchIndex: () => Promise<readonly PageEntry[]> | null
  /**
   * MediaBox bottom edge per page, in PDF user space (pdf.js `page.view[1]`).
   * Enables the bilingual "would the translation land off-page" guard.
   *
   * Note this is deliberately *not* the renderer's scaled `sizes` — those are
   * viewport pixels, and comparing them against user-space rects would make the
   * guard fire (or not fire) on the wrong scale.
   */
  getPageBottoms?: () => Promise<readonly number[]> | undefined
  /** Hand the reviewed plan to the renderer, which turns it into pending
   *  `textEdits` / inserts. Only called from the dialog's Apply. */
  onApply: (plan: PdfTranslationPlan) => void
  /**
   * The app's batch transport. Typed as the shared {@link TranslateBatchFn} so
   * the App can pass its `pdfApi` wrapper directly — the pipeline always
   * supplies `onUnit`, but the type is optional and a narrower parameter here
   * would reject a perfectly good transport.
   */
  translateBatch: TranslateBatchFn
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

export function TranslatePdfDialog(
  props: TranslatePdfDialogProps & { ref?: React.Ref<TranslatePdfDialogHandle> },
): React.JSX.Element {
  const {
    getSearchIndex,
    getPageBottoms,
    onApply,
    translateBatch,
    defaultTargetLang = 'zh-CN',
  } = props
  const [open, setOpen] = useState(false)
  const [bilingual, setBilingual] = useState(false)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [quality, setQuality] = useState<{ overallScore?: number; warnings?: string[] } | undefined>()
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // The blocks captured at extraction time: the apply step re-derives geometry
  // from them, and re-extracting at Apply would silently re-cluster a document
  // the user may have edited while reviewing.
  const blocksRef = useRef<PdfTextBlock[]>([])
  const latestRef = useRef<TranslatedUnit[]>([])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
  }, [])

  useImperativeHandle(
    props.ref,
    (): TranslatePdfDialogHandle => ({
      open(request) {
        // A fresh command must not inherit the previous run's verdict.
        setRows([])
        setQuality(undefined)
        setError(null)
        setBilingual(request?.bilingual === true)
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
      status: event.status,
      progress: event.progress,
      ...(event.completedUnits !== undefined ? { completedUnits: event.completedUnits } : {}),
      ...(event.totalUnits !== undefined ? { totalUnits: event.totalUnits } : {}),
      ...(event.quality ? { quality: event.quality } : {}),
      ...(event.error !== undefined ? { error: event.error } : {}),
    })
  }, [])

  const handleTranslate = useCallback(
    async (args: { sourceLang: string; targetLang: string }): Promise<string | null> => {
      const pending = getSearchIndex()
      if (!pending) {
        setError(t('aiTranslatePdfNoText'))
        return null
      }
      const searchIndex = await pending
      if (searchIndex.length === 0) {
        setError(t('aiTranslatePdfNoText'))
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
        const run = await translatePdfDocument(
          {
            searchIndex,
            pageBottoms: (await getPageBottoms?.()) ?? undefined,
            translateBatch: (request, signal, onUnit) =>
              translateBatch(request, signal ?? controller.signal, (unit) => {
                onUnit?.(unit)
                preview.set(unit.unitId, toRow(unit))
                setRows([...preview.values()])
              }),
            onProgress,
            // Capture the exact extraction this run used; Apply re-derives
            // geometry from these blocks rather than re-extracting, so a
            // document edited while reviewing cannot shift the write targets.
            onBlocks: (extracted) => {
              blocksRef.current = [...extracted]
            },
            // The dialog's Apply performs the write, so the pipeline's own
            // apply step is a no-op here — the document is untouched until then.
            apply: () => {},
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
          setError(run.error ?? t('aiTranslatePdfFailed'))
          return null
        }
        if (run.units.length === 0) {
          setError(t('aiTranslatePdfNoText'))
          return null
        }
        setQuality(run.quality)
        setRows(run.units.map(toRow))
        latestRef.current = run.units
        return run.units.map((unit) => unit.translatedText).join('\n')
      } catch (caught) {
        abortRef.current = null
        setError(caught instanceof Error ? caught.message : String(caught))
        return null
      }
    },
    [cancel, getPageBottoms, getSearchIndex, onProgress, translateBatch],
  )

  const strings = useMemo(
    () => ({
      title: t('aiTranslatePdfTitle'),
      targetLang: t('aiTranslateTargetLang'),
      sourceLang: t('aiTranslatePdfSourceLang'),
      preserveFormat: t('aiTranslatePdfPreserveFormat'),
      bilingual: t('aiTranslatePdfBilingual'),
      swapLanguages: t('aiTranslatePdfSwap'),
      start: t('aiTranslatePdfStart'),
      apply: t('aiTranslatePdfApply'),
      original: t('aiTranslatePdfOriginal'),
      translated: t('aiTranslatePdfTranslated'),
      previewTitle: t('aiTranslatePdfTitle'),
      previewLoading: t('aiTranslatePdfRunning'),
      cancel: t('cancel'),
      unsupported: t('aiTranslatePdfSkipNote'),
    }),
    [],
  )

  return (
    <TranslateDialog
      open={open}
      // The dialog requires a source text; the real per-paragraph list arrives
      // through `previewItems` once the run starts, and a PDF has no single
      // "document text" to show before that.
      sourceText=""
      hasTranslatableContent={getSearchIndex() !== null}
      defaultTargetLang={defaultTargetLang}
      languages={[...TRANSLATE_LANGS]}
      strings={strings}
      previewItems={rows}
      {...(quality ? { previewQuality: quality } : {})}
      bilingual={bilingual}
      onBilingualChange={setBilingual}
      app="pdf"
      onTranslate={handleTranslate}
      onApply={async () => {
        const mode = bilingual ? 'bilingual' : 'replace'
        // A unit whose block was not captured at extraction is dropped, not
        // guessed at: writing a translation onto the wrong paragraph of a PDF
        // is unrecoverable in a way a wrong spreadsheet cell is not.
        const plan = applyPdfTranslations(
          blocksRef.current,
          latestRef.current,
          mode,
          (await getPageBottoms?.()) ?? undefined,
        )
        if (plan.edits.length === 0 && plan.inserts.length === 0) {
          setError(t('aiTranslatePdfNoText'))
          return
        }
        onApply(plan)
        setOpen(false)
      }}
      onCancel={() => {
        cancel()
        setOpen(false)
      }}
    />
  )
}
