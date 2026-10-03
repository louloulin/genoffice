/**
 * Shared whole-document translation pipeline.
 *
 * Every GenOffice application (docs / sheets / slides / pdf) needs the same
 * four-step flow for "translate this whole file":
 *
 *   1. **extract**  — walk the host document model and produce `TranslationUnit[]`
 *   2. **translate** — settle every unit through `translateBatchStream`
 *   3. **apply**    — write the results back through a host-supplied strategy
 *   4. **report**   — emit a uniform progress / quality trail
 *
 * Steps 1 and 3 are inherently host-specific (a ProseMirror doc, an xlsx cell
 * grid and a pdfium text layer have nothing in common), so they arrive as two
 * callbacks. Steps 2 and 4 are identical everywhere, and *were* duplicated
 * inside `apps/docs/src/renderer/ai/AiPanel.tsx` — which is why sheets /
 * slides / pdf only ever shipped a one-shot selection translation. This module
 * owns the shared middle so a new application gets a whole-file path by
 * supplying two functions.
 *
 * Nothing here imports a document model, an editor, or Node built-ins: the
 * module is host-agnostic and runs unchanged in the Electron main process, in
 * the standalone web-server, and inside the Dataflare-embedded editor iframe.
 */

import type {
  EditorRange,
  LanguageCode,
  QualityReport,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateBatchUnitResult,
  TranslationUnit,
} from './types'


// Re-exported so a browser consumer can import everything the pipeline needs
// from this one subpath, without pulling the Node-only root entry.
export type {
  EditorRange,
  LanguageCode,
  QualityReport,
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateBatchUnitResult,
  TranslationUnit,
} from './types'

/**
 * Per-unit settlement callback.
 *
 * It receives the settled unit itself, not the provider's
 * `{ index, total, result }` envelope: an injected transport (a postMessage
 * bridge, an SSE reader) has no meaningful index/total to report, and forcing
 * it to invent one just to satisfy the signature is how adapters end up
 * passing `0, 0` around.
 */
export type TranslateUnitListener = (result: TranslateBatchUnitResult) => void | Promise<void>

/**
 * The transport that settles a batch of units.
 *
 * It is **injected** rather than imported on purpose. `translateBatchStream`
 * lives in `./provider`, which pulls the LLM SDK and Node built-ins — importing
 * it here would make this module unusable in a browser bundle, and the docs
 * renderer (the one host that actually runs the whole-file path today) is a
 * browser bundle that reaches the provider through `window.desktop` /
 * the Dataflare bridge instead. Keeping the dependency a parameter is what lets
 * the same pipeline run in three places without a second copy:
 *   · Electron main / web-server → `(req, opts) => translateBatchStream(req, opts)`
 *   · embedded docs renderer    → `(req) => window.desktop.aiTranslateBatchStream(req)`
 *   · unit tests                → a plain function
 */
export type TranslateBatchFn = (
  request: TranslateBatchRequest,
  signal?: AbortSignal,
  onUnit?: TranslateUnitListener,
) => Promise<TranslateBatchResponse>

/**
 * Lifecycle of a whole-document run. The `started → running → terminal`
 * shape is what the `genoffice-dataflare/v1` `ai-progress` event carries, so
 * a host that forwards {@link TranslateProgress.onProgress} verbatim produces a
 * protocol-valid event stream without a per-app translation table.
 */
export type TranslateProgressStatus = 'started' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TranslateProgress {
  status: TranslateProgressStatus
  /** 0..1. `cancelled` / `failed` report the progress reached so far. */
  progress: number
  completedUnits?: number | undefined
  totalUnits?: number | undefined
  /** Present once at least one batch has reported a quality score. */
  quality?: QualityReport | undefined
  /** The unit that just settled — drives the live per-unit preview row. */
  unit?: TranslateBatchUnitResult | undefined
  /** Terminal-only. */
  error?: string | undefined
}

/** A settled unit paired with the extraction metadata needed to apply it. */
export interface TranslatedUnit {
  unitId: string
  order: number
  kind: TranslationUnit['kind']
  sourceText: string
  translatedText: string
  status: 'translated' | 'memory-hit'
  matchedTerms?: string[] | undefined
  warnings?: string[] | undefined
  range?: EditorRange | null | undefined
  metadata?: Record<string, unknown> | undefined
}

/**
 * How a bilingual run renders. `replace` overwrites the source in place;
 * `bilingual` keeps the source and adds the translation next to it — which
 * concrete structure that is (a following paragraph, an adjacent column, a
 * sibling text box) is the host's decision, so the host maps each unit in
 * {@link TranslateDocumentAdapters.apply} and the pipeline just reports which
 * mode produced the plan.
 */
export type TranslateApplyMode = 'replace' | 'bilingual'

export interface TranslateDocumentRequest {
  /** Extraction order is the apply order; the pipeline preserves it. */
  units: TranslationUnit[]
  sourceLang?: LanguageCode | string | undefined
  targetLang: LanguageCode | string
  /** Defaults to `true`, matching every other translate entry point. */
  preserveFormat?: boolean | undefined
  memoryEnabled?: boolean | undefined
  qualityCheck?: boolean | undefined
  glossaryCategory?: string | undefined
  /** Free-form bucket label forwarded to `translateBatchStream`. */
  scene?: string | undefined
  cacheScope?: string | undefined
  /** Force a bilingual plan even when the caller did not ask. */
  applyMode?: TranslateApplyMode | undefined
}

export interface TranslateDocumentAdapters {
  /**
   * Write settled translations back into the host document. Must be
   * idempotent per run: the pipeline calls it exactly once, after the last
   * batch settles, and never after a cancel.
   */
  apply: (context: {
    units: TranslatedUnit[]
    mode: TranslateApplyMode
    quality?: QualityReport | undefined
  }) => void | Promise<void>
  /** Optional re-extraction used to verify a `replace` apply landed. */
  verify?: (context: { units: TranslatedUnit[] }) => boolean | Promise<boolean>
}

export interface TranslateDocumentOptions extends TranslateDocumentAdapters {
  /** Injected transport. See {@link TranslateBatchFn} for why it is a parameter. */
  translateBatch: TranslateBatchFn
  signal?: AbortSignal | undefined
  onProgress?: (progress: TranslateProgress) => void | Promise<void>
  /**
   * Units per provider call. The default mirrors the docs renderer: 80 units
   * or 90k source characters, whichever trips first, so a migrated
   * application keeps the provider request shape it had before.
   */
  maxUnitsPerBatch?: number | undefined
  maxCharsPerBatch?: number | undefined
}

export interface TranslateDocumentResult {
  status: 'completed' | 'failed' | 'cancelled'
  mode: TranslateApplyMode
  units: TranslatedUnit[]
  quality?: QualityReport | undefined
  error?: string | undefined
  applied: boolean
}

const DEFAULT_MAX_UNITS_PER_BATCH = 80
const DEFAULT_MAX_CHARS_PER_BATCH = 90_000

/** Group units into provider-sized batches without reordering them. */
export function planTranslateBatches(
  units: TranslationUnit[],
  maxUnits = DEFAULT_MAX_UNITS_PER_BATCH,
  maxChars = DEFAULT_MAX_CHARS_PER_BATCH,
): TranslationUnit[][] {
  const batches: TranslationUnit[][] = []
  let current: TranslationUnit[] = []
  let chars = 0
  for (const unit of units) {
    const length = unit.sourceText.length
    const wouldExceed = current.length >= maxUnits || chars + length > maxChars
    if (wouldExceed && current.length > 0) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(unit)
    chars += length
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function asQualityReport(
  quality: { overallScore?: number | undefined; warnings?: string[] | undefined } | undefined,
): QualityReport | undefined {
  if (!quality) return undefined
  return { overallScore: quality.overallScore ?? 0, warnings: quality.warnings ?? [] }
}

/**
 * Run the shared whole-document pipeline.
 *
 * Failure is always *reported*, never swallowed: a provider error surfaces as
 * `status: 'failed'` with the provider's own message, and a cancel as
 * `status: 'cancelled'`. A cancelled run applies nothing — partially
 * translated documents are the one outcome a user cannot distinguish from a
 * successful run, so it is deliberately not offered.
 */
export async function translateDocument(
  request: TranslateDocumentRequest,
  options: TranslateDocumentOptions,
): Promise<TranslateDocumentResult> {
  const mode: TranslateApplyMode = request.applyMode ?? 'replace'
  const totalUnits = request.units.length
  const report = async (progress: TranslateProgress): Promise<void> => {
    if (options.onProgress) await options.onProgress(progress)
  }

  if (totalUnits === 0) {
    await report({ status: 'completed', progress: 1, completedUnits: 0, totalUnits: 0 })
    return { status: 'completed', mode, units: [], applied: false }
  }
  if (!request.targetLang || !request.targetLang.trim()) {
    const error = 'translateDocument expected non-empty `targetLang`'
    await report({ status: 'failed', progress: 0, completedUnits: 0, totalUnits, error })
    return { status: 'failed', mode, units: [], error, applied: false }
  }

  await report({ status: 'started', progress: 0, completedUnits: 0, totalUnits })

  const batches = planTranslateBatches(
    request.units,
    options.maxUnitsPerBatch ?? DEFAULT_MAX_UNITS_PER_BATCH,
    options.maxCharsPerBatch ?? DEFAULT_MAX_CHARS_PER_BATCH,
  )
  const byId = new Map(request.units.map((unit) => [unit.unitId, unit]))
  const settled: TranslatedUnit[] = []
  const scores: number[] = []
  const warnings = new Set<string>()
  // Units the transport has reported, including ones still to be classified
  // below (a failed / blank unit is reported by the transport but never lands
  // in `settled`). Progress must count *reported* units, not *applied* ones —
  // otherwise a document with failures sits at 0% until the very end.
  let reported = 0
  /** One number for every progress event, so the stream and the terminal event
   *  can never disagree about how far the run got. */
  const completedCount = (): number => Math.max(reported, settled.length)

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    if (options.signal?.aborted) {
      await report({
        status: 'cancelled',
        progress: completedCount() / totalUnits,
        completedUnits: completedCount(),
        totalUnits,
      })
      return {
        status: 'cancelled',
        mode,
        units: settled,
        applied: false,
        error: 'cancelled',
      }
    }
    const batch = batches[batchIndex] ?? []
    let response
    try {
      const onUnit: TranslateUnitListener | undefined = options.onProgress
        ? async (result) => {
            reported += 1
            await report({
              status: 'running',
              progress: reported / totalUnits,
              completedUnits: reported,
              totalUnits,
              unit: result,
            })
          }
        : undefined
      response = await options.translateBatch(
        {
          units: batch,
          sourceLang: request.sourceLang,
          targetLang: request.targetLang,
          preserveFormat: request.preserveFormat !== false,
          scene: request.scene,
          memoryEnabled: request.memoryEnabled,
          qualityCheck: request.qualityCheck,
          glossaryCategory: request.glossaryCategory,
          cacheScope: request.cacheScope,
        },
        options.signal,
        onUnit,
      )
    } catch (cause) {
      // A throwing transport is still a failed run with a real message: the
      // host UI shows `error`, so collapsing it into `failed` here keeps the
      // "no silent degradation" rule intact.
      const error = cause instanceof Error ? cause.message : String(cause)
      await report({
        status: 'failed',
        progress: completedCount() / totalUnits,
        completedUnits: completedCount(),
        totalUnits,
        error,
      })
      return { status: 'failed', mode, units: settled, error, applied: false }
    }

    if (!response.ok && !(response.units && response.units.length > 0)) {
      const error = response.error || 'Document translation failed'
      await report({
        status: 'failed',
        progress: completedCount() / totalUnits,
        completedUnits: completedCount(),
        totalUnits,
        error,
      })
      return { status: 'failed', mode, units: settled, error, applied: false }
    }

    for (const result of response.units ?? []) {
      const source = byId.get(result.unitId)
      if (!source) continue
      const translatedText = result.translatedText ?? ''
      if (result.status !== 'translated' && result.status !== 'memory-hit') continue
      if (!translatedText.trim()) continue
      const unitWarnings = [
        ...(result.warnings ?? []),
        ...(result.errorMessage ? [result.errorMessage] : []),
      ]
      for (const warning of unitWarnings) warnings.add(warning)
      settled.push({
        unitId: source.unitId,
        order: source.order,
        kind: source.kind,
        sourceText: source.sourceText,
        translatedText,
        status: result.status,
        matchedTerms: result.matchedTerms,
        warnings: unitWarnings.length > 0 ? unitWarnings : undefined,
        range: result.range ?? source.range,
        metadata: source.metadata,
      })
    }

    // The transport may not have streamed (batched mode), so make sure the
    // per-batch report still reflects the units this batch actually settled.
    if (!options.onProgress) reported = Math.max(reported, settled.length)

    const quality = asQualityReport(response.quality)
    if (quality && typeof response.quality?.overallScore === 'number') {
      scores.push(response.quality.overallScore)
    }
    if (quality) for (const warning of quality.warnings) warnings.add(warning)

    await report({
      status: 'running',
      progress: Math.max(reported / totalUnits, Math.min(0.99, (batchIndex + 1) / batches.length)),
      completedUnits: reported,
      totalUnits,
      quality,
    })
  }

  if (settled.length === 0) {
    const error = 'Document translation returned no usable units'
    await report({
      status: 'failed',
      progress: 0,
      completedUnits: 0,
      totalUnits,
      error,
    })
    return { status: 'failed', mode, units: [], error, applied: false }
  }

  // Extraction order is apply order: a bilingual insert shifts every later
  // position, so a host that applies out of order corrupts the document.
  settled.sort((a, b) => a.order - b.order)
  const finalQuality: QualityReport | undefined =
    scores.length > 0
      ? {
          overallScore: scores.reduce((sum, score) => sum + score, 0) / scores.length,
          warnings: [...warnings],
        }
      : warnings.size > 0
        ? { overallScore: 0, warnings: [...warnings] }
        : undefined

  try {
    await options.apply({ units: settled, mode, quality: finalQuality })
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    await report({
      status: 'failed',
      progress: 0.99,
      completedUnits: completedCount(),
      totalUnits,
      error,
    })
    return { status: 'failed', mode, units: settled, error, applied: false }
  }

  let applied = true
  if (options.verify) {
    try {
      applied = (await options.verify({ units: settled })) !== false
    } catch {
      applied = false
    }
  }
  if (!applied) {
    const error = 'Translated content could not be written back to the document'
    await report({
      status: 'failed',
      progress: 0.99,
      completedUnits: settled.length,
      totalUnits,
      error,
    })
    return { status: 'failed', mode, units: settled, error, applied: false }
  }

  await report({
    status: 'completed',
    progress: 1,
    completedUnits: completedCount(),
    totalUnits,
    quality: finalQuality,
  })
  return { status: 'completed', mode, units: settled, quality: finalQuality, applied: true }
}
