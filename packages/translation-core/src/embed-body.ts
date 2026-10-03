/**
 * Wire-body builder for the embedded (Dataflare-hosted) translation branches.
 *
 * This used to live in `apps/docs/src/shared/translate-embed-body.ts`, which
 * made it unreachable from the other three editors — so sheets / slides / pdf
 * had no way to reach the host's `/office-engine/api/ai/translate[/stream]`
 * endpoint, and whole-document translation existed only in docs. It moved here
 * because it is translation wire shape, not Dataflare protocol: the SDK owns
 * the envelope, this owns the payload both sides agree on.
 *
 * Why it is worth having one copy: the branches each built their own body, and
 * all of them hard-coded `memoryEnabled: true` / `qualityCheck: true` while
 * never sending `glossaryCategory` / `customerName`. The web-server endpoint
 * understands all four fields (see `apps/web-server/src/ai/translate-http.ts`),
 * so an embedded user who turned memory off still got memory lookups, turned
 * quality off and still got warnings, and — the costly one — a customer-scoped
 * document was translated with every customer's glossary in the prompt.
 */

/**
 * The unit shape the body builder accepts.
 *
 * Structurally compatible with `TranslationUnit` (it accepts the extra `path`
 * some file-based callers carry) but the shared fields are declared **as**
 * `TranslationUnit` rather than re-spelled: a hand-written copy drifted once
 * already, and under `exactOptionalPropertyTypes` every caller then has to
 * hand-cast a batch request to get it through.
 */
import type { TranslationUnit } from './types'

export interface EmbedTranslateUnitInput {
  unitId: string
  kind: TranslationUnit['kind'] | string
  sourceText: string
  order?: number | undefined
  path?: string | undefined
  metadata?: Record<string, unknown> | undefined
  range?: TranslationUnit['range']
}

export interface EmbedTranslateBodyOptions {
  requestId: string
  targetLanguage: string
  documentId?: string | undefined
  documentType?: string | undefined
  scene?: string | undefined
  sourceLanguage?: string | undefined
  preserveFormatting?: boolean | undefined
  /** `false` skips the server-side translation memory. Defaults to on. */
  memoryEnabled?: boolean | undefined
  /** `false` skips the post-translation quality assessment. Defaults to on. */
  qualityCheck?: boolean | undefined
  /** Glossary bucket — narrows the KB to that category's terms. */
  glossaryCategory?: string | undefined
  /** Customer name — the confidentiality boundary on customer-private terms. */
  customerName?: string | undefined
}

/** Build the JSON body for `/office-engine/api/ai/translate[/stream]`. */
export function buildEmbedTranslateBody(
  options: EmbedTranslateBodyOptions,
  units: readonly EmbedTranslateUnitInput[],
): Record<string, unknown> {
  return {
    requestId: options.requestId,
    idempotencyKey: options.requestId,
    ...(options.documentId ? { documentId: options.documentId } : {}),
    documentType: options.documentType ?? 'docx',
    ...(options.scene ? { scene: options.scene } : {}),
    sourceLanguage: options.sourceLanguage || 'auto',
    targetLanguage: options.targetLanguage,
    preserveFormatting: options.preserveFormatting !== false,
    // `!== false` (not `?? true`) so an explicit `false` from the caller — the
    // whole point of forwarding the field — survives, while `undefined` keeps
    // the server default of "on".
    memoryEnabled: options.memoryEnabled !== false,
    qualityCheck: options.qualityCheck !== false,
    ...(options.glossaryCategory ? { glossaryCategory: options.glossaryCategory } : {}),
    ...(options.customerName ? { customerName: options.customerName } : {}),
    units: units.map((unit) => ({
      unitId: unit.unitId,
      kind: unit.kind,
      sourceText: unit.sourceText,
      order: unit.order,
      ...(unit.path !== undefined ? { path: unit.path } : {}),
      metadata:
        unit.metadata || unit.range
          ? { ...(unit.metadata || {}), ...(unit.range ? { range: unit.range } : {}) }
          : undefined,
    })),
  }
}

/**
 * Narrow a wire `status` to the pipeline's closed vocabulary.
 *
 * The transport carries `string` because SSE is untyped JSON; without this an
 * unexpected value flows straight into the per-unit state, where a `failed`
 * unit that reads as a translated one is worse than a crash.
 */
export function narrowUnitStatus(
  value: unknown,
): 'translated' | 'memory-hit' | 'failed' | undefined {
  return value === 'translated' || value === 'memory-hit' || value === 'failed' ? value : undefined
}

// ── Stream side ──────────────────────────────────────────────────────────────
//
// The three remaining editors (sheets / slides / pdf) each need to turn the
// host's `/office-engine/api/ai/translate/stream` feed into a
// `TranslateBatchResponse` while pushing per-unit progress. The transport
// plumbing is a few dozen lines and legitimately app-local, but the *parsing*
// and the *accumulation* are not: getting them subtly different is how one app
// ends up counting a `failed` unit as translated while another does not. So
// both live here and the apps keep only the subscribe/unsubscribe shell.

/** One decoded SSE payload from the host translate stream. */
export interface EmbedTranslateStreamPayload {
  type?: string
  status?: string
  error?: string
  message?: string
  unit?: {
    unitId?: string
    status?: string
    sourceText?: string
    translatedText?: string
    matchedTerms?: string[]
    warnings?: string[]
    errorMessage?: string
  }
  quality?: { overallScore?: number; warnings?: string[] }
}

export interface EmbedTranslateUnitResult {
  unitId: string
  sourceText: string
  translatedText?: string
  status?: 'translated' | 'memory-hit' | 'failed'
  matchedTerms?: string[]
  warnings?: string[]
  errorMessage?: string
}

/** Decode one SSE `data:` line. Returns `null` for non-JSON / unparseable data. */
export function parseEmbedTranslateStreamEvent(data: string): EmbedTranslateStreamPayload | null {
  const trimmed = data.trim()
  if (!trimmed.startsWith('{')) return null
  try {
    return JSON.parse(trimmed) as EmbedTranslateStreamPayload
  } catch {
    return null
  }
}

export interface EmbedTranslateBatchAccumulator {
  /** Fold one payload in. Returns the unit when the payload settled one. */
  push(payload: EmbedTranslateStreamPayload): EmbedTranslateUnitResult | null
  /** The batch response so far. `ok` is false as soon as anything failed. */
  result(): { ok: boolean; units: EmbedTranslateUnitResult[]; quality?: { overallScore?: number; warnings?: string[] }; error?: string }
  /** True once the feed reported a terminal event. */
  readonly settled: boolean
  /** Set when the feed reported an explicit failure. */
  readonly error: string | undefined
}

/**
 * Accumulate the host's per-unit feed into one batch response.
 *
 * `ok` is derived from the units themselves rather than from the feed's
 * terminal `status`: a feed that closes cleanly after settling a `failed` unit
 * is a failed batch, and reporting `ok: true` there is exactly the "it says
 * done but the cells are half translated" outcome this pipeline exists to
 * prevent.
 */
export function createEmbedTranslateBatchAccumulator(): EmbedTranslateBatchAccumulator {
  const units = new Map<string, EmbedTranslateUnitResult>()
  let quality: { overallScore?: number; warnings?: string[] } | undefined
  let settled = false
  let error: string | undefined

  return {
    get settled() {
      return settled
    },
    get error() {
      return error
    },
    push(payload) {
      if (payload.type === 'unit' && payload.unit?.unitId) {
        // Narrow *before* building the object: with `exactOptionalPropertyTypes`
        // an unknown status must leave the key absent, not present-and-undefined
        // (which `status?: 'translated' | ...` does not accept and which would
        // serialise as an explicit null to the caller).
        const status = narrowUnitStatus(payload.unit.status)
        const unit: EmbedTranslateUnitResult = {
          unitId: payload.unit.unitId,
          sourceText: payload.unit.sourceText ?? '',
          ...(payload.unit.translatedText !== undefined
            ? { translatedText: payload.unit.translatedText }
            : {}),
          ...(status ? { status } : {}),
          ...(payload.unit.matchedTerms ? { matchedTerms: payload.unit.matchedTerms } : {}),
          ...(payload.unit.warnings ? { warnings: payload.unit.warnings } : {}),
          ...(payload.unit.errorMessage ? { errorMessage: payload.unit.errorMessage } : {}),
        }
        units.set(unit.unitId, unit)
        return unit
      }
      if (payload.type === 'quality' && payload.quality) quality = payload.quality
      if (payload.type === 'error') {
        settled = true
        error = payload.error || payload.message || '翻译流返回 error 事件但没有给出原因'
      }
      if (payload.type === 'complete') {
        settled = true
        // A terminal `status` other than completed/partial means the server
        // itself is reporting a failure; do not overwrite an error already set.
        if (
          payload.status &&
          payload.status !== 'completed' &&
          payload.status !== 'partial' &&
          !error
        ) {
          error = payload.error || `Dataflare translation completed with status "${payload.status}"`
        }
      }
      return null
    },
    result() {
      const list = [...units.values()]
      const failed = list.filter((unit) => unit.status === 'failed')
      return {
        ok: !error && failed.length === 0,
        units: list,
        ...(quality ? { quality } : {}),
        ...(error ? { error } : {}),
      }
    },
  }
}
