import {
  isAiNetworkError,
  isAiOverloadedError,
  isAiQuotaExhaustedError,
  type AiProviderConfig,
  type AiProviderId,
} from '@genoffice/ai-provider'

import {
  buildTranslationPrompt,
  buildTranslateSystemPrompt,
  extractTranslationText,
  normalizeSourceLang,
} from './prompt'
import { assessBatchQuality, assessQuality, warningsFor } from './quality'
import { TranslationMemory } from './memory'
import type { MemoryEntry } from './memory'
import type { KnowledgeBase } from './knowledge-base'
import type {
  TranslateBatchRequest,
  TranslateBatchResponse,
  TranslateBatchUnitResult,
  TranslateRequest,
  TranslateResponse,
} from './types'
import { callLlm } from './llm-client' // W9: seam between translation-core and the underlying LLM SDK

/**
 * Normalize a customer-name filter before it reaches KB resolution.
 *
 * The KB `customerPreference` schema keys preferences on a non-empty string,
 * so an empty / whitespace-only value would match the "no customer" bucket
 * and bleed between tenants. Trim and collapse undefined.
 */
export function normalizeCustomerName(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}


import {
  applyTerminology,
  matchTermsInSource,
  resolveKbForCall,
  terminologyPairs,
  type TerminologyPair,
} from './kb-rules'

/**
 * `translateOne` / `translateBatch` are the public call surface shared by the
 * Electron main-process handlers and the web-server. They wrap
 * `chatForProvider` with the hardened prompt and quality checks so every call
 * site gets the same behaviour and the same error mapping.
 *
 * The shared instance is a singleton so consecutive calls (the typical
 * retranslation flow) hit the in-memory TM.
 */
/** Subset of {@link TranslationMemory} the translator actually calls —
 *  the in-memory and persistent implementations both satisfy it. */
export interface TranslationMemoryLike {
  /** `bucket` scopes the lookup to a glossary / customer; see {@link MemoryEntry.bucket}. */
  lookup(
    sourceLang: string,
    targetLang: string,
    sourceText: string,
    bucket?: string | undefined,
  ): MemoryEntry | null
  save(entry: Omit<MemoryEntry, 'updatedAt'>): void
}

export const sharedMemory = new TranslationMemory()

export interface TranslateOneOptions {
  provider: AiProviderId
  config: AiProviderConfig
  /** Optional external memory; falls back to the shared in-memory TM.
   *  Accepts any object that exposes the methods the translator actually
   *  uses (`lookup` and `save`); the in-memory {@link TranslationMemory} and
   *  the file-backed {@link PersistentTranslationMemory} both satisfy this. */
  memory?: TranslationMemoryLike
  /**
   * Optional translation knowledge base. When provided, the resolved rules
   * (term / forbidden / brand / style / customer preferences) are appended
   * to the system prompt so the model respects the user's house style.
   * Hosts construct one via `new KnowledgeBase({ filePath })` and call
   * `.load()` on startup; the same instance is safe to share across
   * concurrent translate calls.
   */
  knowledgeBase?: KnowledgeBase
  /**
   * When the supplied `memory` exposes `fuzzyLookup`, fall back to a
   * similarity-based hit when no exact entry is found. Defaults to false so
   * the existing one-shot translation flow stays byte-for-byte identical.
   */
  fuzzyMemoryEnabled?: boolean
  /**
   * Extra mandatory `source -> target` pairs on top of the KB terms — the
   * generated `--dictionary` for the document being worked on. Hosts pass the
   * pairs (not the path) so translation-core stays filesystem-free; the
   * web-server resolves `ai:translate-build-dictionary` output into this slot.
   *
   * They are rendered into the system prompt, are matched against the source
   * text for `matchedTerms`, and are enforced on the model output exactly like
   * KB terms.
   */
  dictionary?: readonly TerminologyPair[] | undefined
}

/**
 * Translate a single chunk (selection / single paragraph). Returns the same
 * shape the docs `aiTranslate` IPC contract uses, so the caller can return the
 * value verbatim from the handler.
 */
export async function translateOne(
  request: TranslateRequest,
  opts: TranslateOneOptions,
): Promise<TranslateResponse> {
  // A non-string here used to throw `(request.instruction ?? "").trim is not a
  // function`, which the transport reported as a 500 and which the UI showed
  // as a raw JavaScript expression. Reject the shape instead.
  if (request.instruction !== undefined && typeof request.instruction !== 'string') {
    return { ok: false, error: 'ai:translate expected `instruction` to be a string' }
  }
  if (request.targetLang !== undefined && typeof request.targetLang !== 'string') {
    return { ok: false, error: 'ai:translate expected `targetLang` to be a string' }
  }
  const sourceText = (request.instruction ?? '').trim()
  const targetLang = (request.targetLang ?? '').trim()
  if (!sourceText) return { ok: false, error: 'ai:translate expected non-empty `instruction`' }
  if (!targetLang) return { ok: false, error: 'ai:translate expected non-empty `targetLang`' }
  if (!opts.config) {
    return { ok: false, error: `AI provider "${opts.provider}" not configured` }
  }
  if (opts.provider !== 'codex' && opts.provider !== 'genspark' && !opts.config.apiKey) {
    return {
      ok: false,
      error: `No API key configured for provider "${opts.provider}". Open Settings → AI to add one.`,
    }
  }
  if (opts.provider !== 'codex' && !opts.config.model) {
    return { ok: false, error: `No model selected for "${opts.provider}".` }
  }
  const memory = request.memoryEnabled === false ? null : (opts.memory ?? sharedMemory)
  const sourceLang = normalizeSourceLang(request.sourceLang)
  const preserveFormat = request.preserveFormat !== false

  // Resolve terminology once per call: KB mandatory terms plus whatever
  // dictionary the host layered on top. Both drive the prompt and the
  // `matchedTerms` the UI badges off, so they are computed before any early
  // return — a memory hit applied the same terms.
  const { pairs: termPairs, dictionaryTerms } = resolveTerminology({
    request,
    opts,
    sourceText,
    sourceLang,
    targetLang,
  })
  const matchedTerms = matchTermsInSource(sourceText, termPairs)
  const withTerms = matchedTerms.length > 0 ? { matchedTerms } : {}
  // `TranslateResponse` declares `warnings` and the docs panel surfaces them,
  // but only the batch path ever filled them in: a selection / snippet
  // translation that came back truncated looked identical to a good one.
  const qualityEnabled = request.qualityCheck !== false

  const bucket = bucketFor(request)
  const hit = memory?.lookup(sourceLang, targetLang, sourceText, bucket)
  if (hit) {
    return {
      ok: true,
      translated: hit.translatedText,
      planId: `translate-memory-${Date.now().toString(36)}`,
      sourceLang,
      targetLang,
      preserveFormat,
      status: 'memory-hit',
      ...(qualityEnabled ? warningsOption(sourceText, hit.translatedText) : {}),
      ...withTerms,
    }
  }
  // Optional fuzzy fallback — only when the host opts in by passing
  // `fuzzyMemoryEnabled: true` and the memory exposes `fuzzyLookup`.
  // PersistentTranslationMemory ships this method; the plain TranslationMemory
  // does not, so the lookup stays exact-match for legacy callers.
  if (
    opts.fuzzyMemoryEnabled &&
    memory &&
    typeof (memory as { fuzzyLookup?: unknown }).fuzzyLookup === 'function'
  ) {
    // SAFETY: the optional `fuzzyLookup` lives only on PersistentTranslationMemory;
    // the plain TranslationMemory class does not declare it. The previous
    // `typeof ... === 'function'` guard proves the method is callable, but
    // TypeScript cannot infer that narrowing across the type assertion.
    // We therefore re-cast through `unknown` and pin the call signature so
    // a future refactor that breaks the method shape fails this build, not
    // runtime.
    const fuzzyHit = (
      memory as unknown as {
        fuzzyLookup: (
          s: string,
          t: string,
          x: string,
          b?: string,
        ) => { translatedText: string; confidence: number } | null
      }
    ).fuzzyLookup(sourceLang, targetLang, sourceText, bucket)
    if (fuzzyHit) {
      return {
        ok: true,
        translated: fuzzyHit.translatedText,
        planId: `translate-fuzzy-${Date.now().toString(36)}`,
        sourceLang,
        targetLang,
        preserveFormat,
        status: 'memory-hit',
        warnings: [`fuzzy-match:${fuzzyHit.confidence.toFixed(2)}`],
        ...withTerms,
      }
    }
  }

  const system = buildTranslateSystemPrompt({
    sourceLang,
    targetLang,
    preserveFormat,
    glossaryCategory: request.glossaryCategory,
    ...(request.customerName !== undefined ? { customerName: normalizeCustomerName(request.customerName) } : {}),
    ...(opts.knowledgeBase ? { knowledgeBase: opts.knowledgeBase } : {}),
    ...(dictionaryTerms.length > 0 ? { dictionaryTerms } : {}),
  })
  const metadata: Record<string, string> = {}
  if (request.glossaryCategory) metadata.glossaryCategory = request.glossaryCategory
  if (request.customerName) metadata.customerName = request.customerName
  if (request.qualityCheck !== undefined) metadata.qualityCheck = String(request.qualityCheck)

  // Translation is a deterministic transform, not a reasoning task. Asking the
  // endpoint to skip its chain-of-thought keeps the answer short and — on the
  // small local models this pipeline is often pointed at — prevents the model
  // from spending its entire output budget "thinking" before the first
  // translated character. Endpoints that do not support the field never see
  // it (see ChatCallOptions in @genoffice/ai-provider).
  const result = await callLlm({
    provider: opts.provider,
    config: opts.config,
    systemPrompt: system,
    userPrompt: buildTranslationPrompt(sourceText),
    reasoningEffort: 'none',
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  })

  if (!result.ok) {
    return { ok: false, error: describeTranslationFailure(result) }
  }
  const extracted = extractTranslationText(result.content ?? '')
  if (!extracted) {
    return { ok: false, error: 'Translation response did not contain final text.' }
  }
  // Enforce the mandatory terms the model may have left in the source language.
  const translated = applyTerminology(extracted, termPairs)
  if (memory) {
    memory.save({
      sourceLang,
      targetLang,
      sourceText,
      translatedText: translated,
      ...(bucket !== undefined ? { bucket } : {}),
    })
  }
  return {
    ok: true,
    translated,
    planId: `translate-${Date.now().toString(36)}`,
    sourceLang,
    targetLang,
    preserveFormat,
    status: 'translated',
    ...(qualityEnabled ? warningsOption(sourceText, translated) : {}),
    ...withTerms,
  }
}

/**
 * `warnings` as an optional response field. An empty array is omitted so a
 * clean translation keeps the exact shape the existing callers/tests expect.
 */
function warningsOption(
  sourceText: string,
  translated: string | undefined,
): {
  warnings?: string[]
} {
  const warnings = assessQuality(sourceText, translated).warnings
  return warnings.length > 0 ? { warnings } : {}
}

/**
 * Build the per-call terminology for {@link translateOne}.
 *
 * `pairs` is everything that can rewrite the output (KB mandatory terms first,
 * then host dictionary pairs). `dictionaryTerms` is the subset the prompt
 * actually needs: the pairs whose source appears in this specific `sourceText`,
 * so a 400-segment dictionary does not blow up the system prompt for a one-line
 * snippet.
 */
function resolveTerminology(input: {
  request: TranslateRequest
  opts: TranslateOneOptions
  sourceText: string
  sourceLang: string
  targetLang: string
}): { pairs: TerminologyPair[]; dictionaryTerms: TerminologyPair[] } {
  const { request, opts, sourceText, sourceLang, targetLang } = input
  const fromKb = opts.knowledgeBase
    ? terminologyPairs(
        resolveKbForCall(opts.knowledgeBase, {
          sourceLang,
          targetLang,
          ...(request.glossaryCategory !== undefined ? { category: request.glossaryCategory } : {}),
          ...(request.customerName !== undefined ? { customerName: normalizeCustomerName(request.customerName) } : {}),
        }),
      )
    : []
  const fromDictionary = opts.dictionary ?? []
  const dictionaryTerms = fromDictionary.filter((pair) => sourceText.includes(pair.source))
  // `applyTerminology` rewrites with `split/join` and documents that its input
  // must already be longest-source-first (`terminologyPairs` sorts the KB that
  // way). Concatenating the dictionary after the KB broke that invariant
  // whenever a KB term was a substring of a dictionary term: the KB's `fabric`
  // ran first and left "布料 weight spec", destroying the `fabric weight`
  // mapping before it was reached. Re-sort the merge so the invariant holds for
  // the combined set, not just for each half.
  const pairs = [...fromKb, ...fromDictionary].sort((a, b) => b.source.length - a.source.length)
  return { pairs, dictionaryTerms }
}

/**
 * Turn a failed LLM result into a message a translator can act on.
 *
 * The provider layer already classifies failures (`overloaded`, `credits`,
 * `network`, `timeout`), but translation-core used to forward only the
 * `overloaded` case and hand every other body straight through. A MiniMax
 * 429 whose body is a 300-character JSON blob ("已达到 Token Plan 用量上限…")
 * therefore reached the snippet pane verbatim — the user saw a wall of
 * provider JSON instead of "your credits are exhausted, top up".
 *
 * The classifier order matters: a 429 that also names a quota problem is a
 * credits failure (retrying cannot help), not a transient burst to ride out.
 * `isAiQuotaExhaustedError` and `isAiOverloadedError` are mutually exclusive
 * by construction (see @genoffice/ai-provider/overload-error).
 */
function describeTranslationFailure(result: { error?: string; overloaded?: boolean }): string {
  const raw = typeof result.error === 'string' ? result.error : ''
  if (isAiQuotaExhaustedError(raw)) {
    return (
      'The AI provider reports that your credits or quota are exhausted. ' +
      'Top up the account or switch providers in Settings → AI, then retry.'
    )
  }
  if (result.overloaded || isAiOverloadedError(raw)) {
    return 'AI service is busy — please retry shortly.'
  }
  if (isAiNetworkError(raw)) {
    return 'Could not reach the AI provider — check your network connection and retry.'
  }
  return raw || 'Translation failed'
}

/**
 * Terminology for a batch call. The dictionary subset injected into the prompt
 * is per-unit (see {@link resolveTerminology}); this only needs the pairs used
 * for `matchedTerms` and output enforcement.
 */
/**
 * The glossary / customer scope a translation runs under.
 *
 * Used as the cache bucket for the translation memory so a term translated
 * for customer A is never replayed for customer B. `glossaryCategory` and
 * `customerName` are unified because the renderer paths blur them (docs
 * sends the customer as `glossaryCategory`).
 */
function bucketFor(request: {
  glossaryCategory?: string | undefined
  customerName?: string | undefined
}): string | undefined {
  const raw = request.glossaryCategory ?? request.customerName
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function terminologyForBatch(
  request: TranslateBatchRequest,
  opts: TranslateOneOptions,
  sourceLang: string,
  targetLang: string,
): TerminologyPair[] {
  // Pass glossaryCategory through so per-customer / per-domain KB buckets
  // narrow the term set before matchedTerms is computed. The legacy shape
  // dropped it and produced empty matchedTerms for any batch that asked
  // for a customer bucket.
  return resolveTerminology({
    request: {
      instruction: '',
      targetLang,
      ...(request.glossaryCategory !== undefined
        ? { glossaryCategory: request.glossaryCategory }
        : {}),
      ...(request.customerName !== undefined ? { customerName: normalizeCustomerName(request.customerName) } : {}),
    },
    opts,
    sourceText: '',
    sourceLang,
    targetLang,
  }).pairs
}

/**
 * Reject a batch element whose shape would otherwise throw.
 *
 * `units` is untyped JSON on every wire that reaches this function, so an
 * element can be null, a bare string, or an object whose `sourceText` is a
 * number. `matchTermsInSource` reads `sourceText.includes` and
 * `TranslationMemory.lookup` reads `sourceText.trim`, so a single such element
 * rejected the whole `Promise.all` — the caller lost the rest of the document
 * and the transport reported a server fault for its own malformed request.
 * Report it as the failed unit it is instead.
 *
 * Returns null when the element is usable.
 */
function malformedUnitResult(index: number, raw: unknown): TranslateBatchUnitResult | null {
  const unit = raw as { unitId?: unknown; sourceText?: unknown; range?: unknown } | null
  if (typeof unit?.sourceText === 'string') return null
  const unitId = typeof unit?.unitId === 'string' ? unit.unitId : ''
  const range = (unit?.range ?? null) as TranslateBatchUnitResult['range']
  const reason =
    unit === null || typeof unit !== 'object'
      ? `ai:translate-batch expected unit ${index} to be an object`
      : `ai:translate-batch expected unit ${index} \`sourceText\` to be a string`
  return {
    unitId,
    sourceText: '',
    translatedText: '',
    status: 'failed',
    warnings: ['malformed-unit'],
    errorMessage: reason,
    range,
  }
}

/**
 * Shape of a unit that never ran because the batch was aborted.
 *
 * The SSE handler relies on positional `units[]` to reconcile counts with
 * per-unit events, so the slot cannot stay empty. Marking it `failed` keeps
 * the existing status enum stable; the `errorMessage` lets the UI distinguish
 * "provider refused" from "user clicked cancel".
 */
function abortedUnitResult(index: number, raw: unknown): TranslateBatchUnitResult {
  const u = raw as { unitId?: unknown; sourceText?: unknown } | undefined
  const unitId = typeof u?.unitId === 'string' ? u.unitId : `unit-${index}`
  const sourceText = typeof u?.sourceText === 'string' ? u.sourceText : ''
  return {
    unitId,
    sourceText,
    status: 'failed',
    errorMessage: 'aborted',
  }
}

/** `TranslateBatchUnitResult.unitId` is a string on the wire contract; the
 *  renderer keys its own map on it, so a non-string must not leak through. */
function unitIdOf(unit: { unitId?: unknown }): string {
  return typeof unit.unitId === 'string' ? unit.unitId : ''
}

/** Translate a batch of units in parallel; preserves order and per-unit status. */
export async function translateBatch(
  request: TranslateBatchRequest,
  opts: TranslateOneOptions,
): Promise<TranslateBatchResponse> {
  if (!Array.isArray(request.units) || request.units.length === 0) {
    return { ok: false, error: 'ai:translate-batch expected a non-empty `units` array' }
  }
  if (request.targetLang !== undefined && typeof request.targetLang !== 'string') {
    return { ok: false, error: 'ai:translate-batch expected `targetLang` to be a string' }
  }
  const memory = request.memoryEnabled === false ? null : (opts.memory ?? sharedMemory)
  const sourceLang = normalizeSourceLang(request.sourceLang)
  const targetLang = (request.targetLang ?? '').trim()
  const preserveFormat = request.preserveFormat !== false
  if (!targetLang) return { ok: false, error: 'ai:translate-batch expected non-empty `targetLang`' }

  const termPairs = terminologyForBatch(request, opts, sourceLang, targetLang)
  const batchBucket = bucketFor(request)

  const settled = await Promise.all(
    request.units.map(async (unit, index): Promise<TranslateBatchUnitResult> => {
      const malformed = malformedUnitResult(index, unit)
      if (malformed) return malformed
      const sourceText = unit.sourceText as string
      const matchedTerms = matchTermsInSource(sourceText, termPairs)
      const hit = memory?.lookup(sourceLang, targetLang, sourceText, batchBucket)
      if (hit) {
        return {
          unitId: unitIdOf(unit),
          sourceText,
          translatedText: hit.translatedText,
          status: 'memory-hit',
          range: unit.range ?? null,
          ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
        }
      }
      const res = await translateOne(
        {
          instruction: sourceText,
          sourceLang,
          targetLang,
          preserveFormat,
          range: unit.range ?? null,
          memoryEnabled: request.memoryEnabled,
          qualityCheck: request.qualityCheck,
          glossaryCategory: request.glossaryCategory,
          ...(request.customerName !== undefined ? { customerName: normalizeCustomerName(request.customerName) } : {}),
        },
        opts,
      )
      const status: TranslateBatchUnitResult['status'] = res.ok ? 'translated' : 'failed'
      // `qualityCheck: false` is a per-request opt-out on the wire contract
      // (types.ts) and the docs renderer shows the score next to the document,
      // so a caller that disabled it must not receive a real number back — it
      // used to be ignored here while the web-server handler honoured it,
      // which made desktop and web disagree about the same request.
      const qualityEnabled = request.qualityCheck !== false
      const warnings = qualityEnabled
        ? res.ok
          ? warningsFor(unit, res.translated)
          : ['provider-error']
        : []
      const result: TranslateBatchUnitResult = {
        unitId: unitIdOf(unit),
        sourceText,
        status,
        warnings,
        range: unit.range ?? null,
      }
      if (res.translated !== undefined) result.translatedText = res.translated
      if (!res.ok && res.error) result.errorMessage = res.error
      if (res.matchedTerms && res.matchedTerms.length > 0) result.matchedTerms = res.matchedTerms
      return result
    }),
  )

  const ok = settled.every((u) => u.status === 'translated' || u.status === 'memory-hit')
  const quality = request.qualityCheck === false ? undefined : assessBatchQuality(settled)
  const failed = settled.find((u) => u.status === 'failed')
  const response: TranslateBatchResponse = { ok, units: settled, ...(quality ? { quality } : {}) }
  if (failed?.errorMessage) response.error = failed.errorMessage
  return response
}

/**
 * Options for {@link translateBatchStream}. The streaming variant is wire-shape
 * compatible with {@link translateBatch} but exposes per-unit callbacks so SSE
 * handlers can emit events as each unit settles. Concurrency is bounded so a
 * 500-unit document does not flood the LLM provider with simultaneous requests.
 */
export interface TranslateBatchStreamOptions {
  /**
   * Max in-flight provider calls at any moment. Defaults to 25 (matches the
   * Dataflare parent's chunk size). Lower values throttle provider load; higher
   * values increase throughput but risk rate-limits.
   */
  concurrency?: number
  /**
   * Called once per settled unit. Receives the unit index + total + final result.
   * The callback runs sequentially in completion order (not input order); SSE
   * handlers are expected to look up the unit by `unitId` if they need ordering.
   */
  onUnit?: (event: {
    index: number
    total: number
    result: TranslateBatchUnitResult
  }) => void | Promise<void>
  /**
   * Abort signal checked between unit settlements. When the signal aborts the
   * core layer stops scheduling new units, marks any remaining units as
   * `status: 'failed'` with `errorMessage: 'aborted'`, and returns. Already
   * in-flight provider calls still complete (no mid-flight cancel through the
   * LLM client yet); the SSE handler is expected to close its socket from its
   * own `AbortController` once the abort fires.
   */
  signal?: AbortSignal
}

/**
 * Streaming variant of {@link translateBatch}: settles units under a bounded
 * concurrency budget and fires `onUnit` for each completed unit. Returns the
 * same {@link TranslateBatchResponse} as the non-streaming variant, suitable for
 * callers that just need the aggregate (e.g. the IPC path that returns the
 * final shape to Electron docs / sheets / slides).
 */
export async function translateBatchStream(
  request: TranslateBatchRequest,
  opts: TranslateOneOptions,
  streamOpts: TranslateBatchStreamOptions = {},
): Promise<TranslateBatchResponse> {
  if (!Array.isArray(request.units) || request.units.length === 0) {
    return { ok: false, error: 'ai:translate-batch expected a non-empty `units` array' }
  }
  const memory = request.memoryEnabled === false ? null : (opts.memory ?? sharedMemory)
  const sourceLang = normalizeSourceLang(request.sourceLang)
  const targetLang = (request.targetLang ?? '').trim()
  const preserveFormat = request.preserveFormat !== false
  if (!targetLang) return { ok: false, error: 'ai:translate-batch expected non-empty `targetLang`' }

  const total = request.units.length
  const concurrency = Math.max(1, Math.min(streamOpts.concurrency ?? 25, total))
  const settled: TranslateBatchUnitResult[] = new Array(total)
  const termPairs = terminologyForBatch(request, opts, sourceLang, targetLang)
  const batchBucket = bucketFor(request)

  // Build a unit-settler that re-uses the same per-unit logic as translateBatch.
  const settleOne = async (index: number): Promise<void> => {
    const unit = request.units[index]
    // sparse array (noUncheckedIndexedAccess): bail with the same malformed
    // shape a missing sourceText produces, so `settled[index]` is always set.
    if (unit === undefined) {
      const malformed = malformedUnitResult(index, unit)
      settled[index] = malformed!
      if (streamOpts.onUnit) await streamOpts.onUnit({ index, total, result: malformed! })
      return
    }
    // A malformed element used to `return` here, which left a hole in
    // `settled`: sparse `Array.prototype.every` skips holes (so the batch
    // reported `ok`) and `find` on one threw. Fill the slot explicitly.
    const malformed = malformedUnitResult(index, unit)
    if (malformed) {
      settled[index] = malformed
      if (streamOpts.onUnit) await streamOpts.onUnit({ index, total, result: malformed })
      return
    }
    const sourceText = unit.sourceText as string
    const matchedTerms = matchTermsInSource(sourceText, termPairs)
    const hit = memory?.lookup(sourceLang, targetLang, sourceText, batchBucket)
    let result: TranslateBatchUnitResult
    if (hit) {
      result = {
        unitId: unitIdOf(unit),
        sourceText,
        translatedText: hit.translatedText,
        status: 'memory-hit',
        range: unit.range ?? null,
        ...(matchedTerms.length > 0 ? { matchedTerms } : {}),
      }
    } else {
      const res = await translateOne(
        {
          instruction: sourceText,
          sourceLang,
          targetLang,
          preserveFormat,
          range: unit.range ?? null,
          memoryEnabled: request.memoryEnabled,
          qualityCheck: request.qualityCheck,
          glossaryCategory: request.glossaryCategory,
          ...(request.customerName !== undefined ? { customerName: normalizeCustomerName(request.customerName) } : {}),
        },
        opts,
      )
      const status: TranslateBatchUnitResult['status'] = res.ok ? 'translated' : 'failed'
      // See translateBatch: `qualityCheck: false` must suppress both the
      // per-unit warnings and the batch score.
      const warnings =
        request.qualityCheck === false
          ? []
          : res.ok
            ? warningsFor(unit, res.translated)
            : ['provider-error']
      result = {
        unitId: unitIdOf(unit),
        sourceText,
        status,
        warnings,
        range: unit.range ?? null,
      }
      if (res.translated !== undefined) result.translatedText = res.translated
      if (!res.ok && res.error) result.errorMessage = res.error
      if (res.matchedTerms && res.matchedTerms.length > 0) result.matchedTerms = res.matchedTerms
    }
    settled[index] = result
    if (streamOpts.onUnit) {
      await streamOpts.onUnit({ index, total, result })
    }
  }

  // Bounded-concurrency driver: pull the next pending index when a slot frees up.
  let nextIndex = 0
  const signal = streamOpts.signal
  const workers = Array.from({ length: concurrency }, async (): Promise<void> => {
    for (let i = nextIndex++; i < total; i = nextIndex++) {
      if (signal?.aborted) {
        // Fill the remaining slots with an aborted-shape failure so the
        // caller's positional `units[]` stays well-formed. Without this the
        // downstream SSE handler would emit `complete` with a `totalUnits`
        // count that does not match the wire events.
        const aborted = abortedUnitResult(i, request.units[i])
        settled[i] = aborted
        if (streamOpts.onUnit) await streamOpts.onUnit({ index: i, total, result: aborted })
        continue
      }
      await settleOne(i)
    }
    // explicit return for array-callback-return; the for-loop exit path
    // already drops out at `i >= total`, so the function resolves void.
    return
  })
  await Promise.all(workers)

  const ok = settled.every((u) => u.status === 'translated' || u.status === 'memory-hit')
  const quality = request.qualityCheck === false ? undefined : assessBatchQuality(settled)
  const failed = settled.find((u) => u.status === 'failed')
  const response: TranslateBatchResponse = { ok, units: settled, ...(quality ? { quality } : {}) }
  if (failed?.errorMessage) response.error = failed.errorMessage
  return response
}
