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
  TranslationErrorCode,
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
  TranslationErrorCode,
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
export type TranslateProgressStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'completed-with-failures'
  | 'failed'
  | 'cancelled'

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
  /**
   * Retry policy for transient per-unit failures. Defaults to 3 retries with
   * exponential backoff + jitter (see {@link TranslateRetryPolicy}).
   */
  retry?: TranslateRetryPolicy | undefined
  /**
   * Resume store. When supplied, a unit whose translation is already recorded
   * is reused verbatim (no provider call) and every newly settled unit is
   * saved. Omit it for a one-shot run with no resume.
   */
  checkpoint?: TranslateCheckpoint | undefined
}

/**
 * A unit that could not be translated, with the reason the pipeline will show
 * the user. `attempts` counts the initial call plus every retry.
 */
export interface TranslateUnitFailure {
  unitId: string
  reason: string
  errorCode: TranslationErrorCode
  attempts: number
}

/** Persisted per-unit translation, keyed by `unitId`. */
export interface TranslateCheckpoint {
  /** Return a previously settled result, or null/undefined for a cache miss. */
  load(unitId: string): TranslateBatchUnitResult | null | undefined | Promise<TranslateBatchUnitResult | null | undefined>
  /** Record a settled result. Called once per successfully translated unit. */
  save(unitId: string, result: TranslateBatchUnitResult): void | Promise<void>
}

/**
 * Backoff for retryable failures. Only `timeout` / `network` / `overloaded` /
 * `server` are retried — `credits`, `auth` and `content-policy` are permanent
 * for the run, so retrying would just repeat the refusal.
 */
export interface TranslateRetryPolicy {
  /** Retries *after* the initial attempt. Default 3. */
  maxRetries?: number | undefined
  /** First backoff in ms; doubles each retry. Default 500. */
  baseDelayMs?: number | undefined
  /** Ceiling for a single backoff. Default 8000. */
  maxDelayMs?: number | undefined
  /** Random fraction (0..1) added to each delay to de-synchronise retries. Default 0.25. */
  jitter?: number | undefined
  /** Sleep seam for tests; defaults to `setTimeout`. */
  sleep?: ((ms: number) => Promise<void>) | undefined
}

export interface TranslateDocumentResult {
  status: 'completed' | 'completed-with-failures' | 'failed' | 'cancelled'
  mode: TranslateApplyMode
  units: TranslatedUnit[]
  quality?: QualityReport | undefined
  error?: string | undefined
  applied: boolean
  /** Units that exhausted their retries (or failed permanently) this run. */
  failures: TranslateUnitFailure[]
}

const DEFAULT_MAX_UNITS_PER_BATCH = 80
const DEFAULT_MAX_CHARS_PER_BATCH = 90_000
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_RETRY_MAX_DELAY_MS = 8_000
const DEFAULT_RETRY_JITTER = 0.25

/** Failure classes worth retrying; everything else is permanent for the run. */
const RETRYABLE_ERROR_CODES: ReadonlySet<TranslationErrorCode> = new Set<TranslationErrorCode>([
  'timeout',
  'network',
  'overloaded',
  'server',
])

interface ResolvedRetryPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitter: number
  sleep: (ms: number) => Promise<void>
}

function resolveRetryPolicy(policy: TranslateRetryPolicy | undefined): ResolvedRetryPolicy {
  const clampInt = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
  const base = clampInt(policy?.baseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS)
  const max = clampInt(policy?.maxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS)
  const jitter = typeof policy?.jitter === 'number' && policy.jitter >= 0 ? policy.jitter : DEFAULT_RETRY_JITTER
  return {
    maxRetries: clampInt(policy?.maxRetries, DEFAULT_MAX_RETRIES),
    baseDelayMs: base,
    maxDelayMs: Math.max(max, base),
    jitter,
    sleep: policy?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
}

/** Exponential backoff with jitter; attempt is 1-based (the first retry). */
function retryDelay(policy: ResolvedRetryPolicy, attempt: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return exponential + exponential * policy.jitter * Math.random()
}

/** Whether a settled result carries a usable translation. */
function isUsableResult(result: TranslateBatchUnitResult | null | undefined): boolean {
  if (!result) return false
  if (result.status !== 'translated' && result.status !== 'memory-hit') return false
  return typeof result.translatedText === 'string' && result.translatedText.trim().length > 0
}

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
    return { status: 'completed', mode, units: [], applied: false, failures: [] }
  }
  if (!request.targetLang || !request.targetLang.trim()) {
    const error = 'translateDocument expected non-empty `targetLang`'
    await report({ status: 'failed', progress: 0, completedUnits: 0, totalUnits, error })
    return { status: 'failed', mode, units: [], error, applied: false, failures: [] }
  }

  await report({ status: 'started', progress: 0, completedUnits: 0, totalUnits })

  const byId = new Map(request.units.map((unit) => [unit.unitId, unit]))
  const settled: TranslatedUnit[] = []
  const scores: number[] = []
  const warnings = new Set<string>()
  const failures: TranslateUnitFailure[] = []
  /** Failures not yet given up on — a later retry can still clear them. */
  const pendingFailures = new Map<
    string,
    { reason: string; errorCode: TranslationErrorCode; attempts: number }
  >()
  const retry = resolveRetryPolicy(options.retry)

  // Units the transport has reported, including ones still to be classified
  // below (a failed / blank unit is reported by the transport but never lands
  // in `settled`). Progress must count *reported* units, not *applied* ones —
  // otherwise a document with failures sits at 0% until the very end.
  let reported = 0
  /** One number for every progress event, so the stream and the terminal event
   *  can never disagree about how far the run got. */
  const completedCount = (): number => Math.max(reported, settled.length)

  /** Land a usable result in `settled` and persist it to the checkpoint. */
  const accept = async (result: TranslateBatchUnitResult, source: TranslationUnit): Promise<void> => {
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
      translatedText: result.translatedText ?? '',
      status: result.status as 'translated' | 'memory-hit',
      matchedTerms: result.matchedTerms,
      warnings: unitWarnings.length > 0 ? unitWarnings : undefined,
      range: result.range ?? source.range,
      metadata: source.metadata,
    })
    pendingFailures.delete(source.unitId)
    if (options.checkpoint) {
      try {
        await options.checkpoint.save(source.unitId, result)
      } catch {
        // Resume is best-effort: a store that cannot persist must not fail the
        // run the user actually asked for.
      }
    }
  }

  // Resume: reuse every unit the checkpoint already holds, and only send the
  // rest to the provider. A recorded unit is never re-translated — that is the
  // whole point of the checkpoint (no duplicate calls, no duplicate billing).
  const pendingUnits: TranslationUnit[] = []
  if (options.checkpoint) {
    for (const unit of request.units) {
      let hit: TranslateBatchUnitResult | null | undefined
      try {
        hit = await options.checkpoint.load(unit.unitId)
      } catch {
        hit = null
      }
      if (isUsableResult(hit) && hit) await accept(hit, unit)
      else pendingUnits.push(unit)
    }
    reported = settled.length
    if (settled.length > 0) {
      await report({
        status: 'running',
        progress: settled.length / totalUnits,
        completedUnits: settled.length,
        totalUnits,
      })
    }
  } else {
    pendingUnits.push(...request.units)
  }

  const batches = planTranslateBatches(
    pendingUnits,
    options.maxUnitsPerBatch ?? DEFAULT_MAX_UNITS_PER_BATCH,
    options.maxCharsPerBatch ?? DEFAULT_MAX_CHARS_PER_BATCH,
  )

  const runBatch = (
    batchUnits: TranslationUnit[],
    stream: boolean,
  ): Promise<TranslateBatchResponse> => {
    const onUnit: TranslateUnitListener | undefined =
      stream && options.onProgress
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
    return options.translateBatch(
      {
        units: batchUnits,
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
  }

  /**
   * One pass over a batch's results: land the usable ones, remember the failed
   * ones, and return the units worth retrying. Successes are never re-sent —
   * only the units in the returned array go back to the transport.
   */
  const settlePass = async (
    results: TranslateBatchUnitResult[],
    attempt: number,
  ): Promise<TranslationUnit[]> => {
    const retryable: TranslationUnit[] = []
    for (const result of results) {
      const source = byId.get(result.unitId)
      if (!source) continue
      if (isUsableResult(result)) {
        await accept(result, source)
        continue
      }
      const errorCode: TranslationErrorCode = result.errorCode ?? 'unknown'
      pendingFailures.set(source.unitId, {
        reason: result.errorMessage || 'Translation failed',
        errorCode,
        attempts: attempt,
      })
      if (RETRYABLE_ERROR_CODES.has(errorCode)) retryable.push(source)
    }
    return retryable
  }

  const failedRun = async (
    error: string,
    progress: number,
    completed: number,
  ): Promise<TranslateDocumentResult> => {
    await report({ status: 'failed', progress, completedUnits: completed, totalUnits, error })
    return { status: 'failed', mode, units: settled, error, applied: false, failures }
  }

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
        failures: [],
      }
    }
    const batch = batches[batchIndex] ?? []
    let response: TranslateBatchResponse
    try {
      response = await runBatch(batch, true)
    } catch (cause) {
      // A throwing transport is still a failed run with a real message: the
      // host UI shows `error`, so collapsing it into `failed` here keeps the
      // "no silent degradation" rule intact.
      const error = cause instanceof Error ? cause.message : String(cause)
      return failedRun(error, completedCount() / totalUnits, completedCount())
    }

    if (!response.ok && !(response.units && response.units.length > 0)) {
      return failedRun(
        response.error || 'Document translation failed',
        completedCount() / totalUnits,
        completedCount(),
      )
    }

    let pending = await settlePass(response.units ?? [], 1)

    // Retry only the transient failures, with exponential backoff + jitter.
    // Cancelling mid-retry keeps the checkpoint (the accumulated `settled`
    // units are already saved) but still writes nothing back to the document.
    let attempt = 0
    while (pending.length > 0 && attempt < retry.maxRetries) {
      attempt += 1
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
          failures: [],
        }
      }
      await retry.sleep(retryDelay(retry, attempt))
      let retryResponse: TranslateBatchResponse
      try {
        retryResponse = await runBatch(pending, false)
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause)
        return failedRun(error, completedCount() / totalUnits, completedCount())
      }
      pending = await settlePass(retryResponse.units ?? [], attempt + 1)
    }
    // Units still in `pending` after the budget are swept into `failures` by
    // the single post-loop pass over `pendingFailures` — recording them here
    // too would list each one twice.

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

  // Permanent failures recorded during the passes never entered `pending`.
  for (const [unitId, info] of pendingFailures) {
    failures.push({ unitId, ...info })
    warnings.add(info.reason)
  }

  if (settled.length === 0 && failures.length > 0) {
    const error = `Document translation failed for all ${failures.length} unit(s)`
    await report({ status: 'failed', progress: 0, completedUnits: 0, totalUnits, error })
    return { status: 'failed', mode, units: [], error, applied: false, failures }
  }
  if (settled.length === 0) {
    const error = 'Document translation returned no usable units'
    await report({ status: 'failed', progress: 0, completedUnits: 0, totalUnits, error })
    return { status: 'failed', mode, units: [], error, applied: false, failures }
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
    return { status: 'failed', mode, units: settled, error, applied: false, failures }
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
    return { status: 'failed', mode, units: settled, error, applied: false, failures }
  }

  // A run with skipped units is not a clean success: the host must be able to
  // tell "everything translated" from "translated what it could".
  const finalStatus = failures.length > 0 ? 'completed-with-failures' : 'completed'
  await report({
    status: finalStatus,
    progress: 1,
    completedUnits: completedCount(),
    totalUnits,
    quality: finalQuality,
  })
  return { status: finalStatus, mode, units: settled, quality: finalQuality, applied: true, failures }
}
