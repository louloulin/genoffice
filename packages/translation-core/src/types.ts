/**
 * Public types for the AI translation core.
 *
 * Three call sites share these shapes:
 *  1. the Electron main-process IPC handlers in docs / sheets / slides
 *  2. the standalone web-server (`apps/web-server/src/ai/chat.ts`)
 *  3. the Dataflare bridge in the docs renderer (`apps/docs/src/renderer/web-bridge.ts`)
 *
 * Keep these in lock-step with the renderer-side TypeScript interfaces declared
 * in `apps/docs/src/shared/ipc.ts` (the `aiTranslate` / `aiTranslateBatch`
 * request and response shapes) — those are the wire contract.
 *
 * Note: optional fields use `T | undefined` (not bare `T?`) so the types
 * survive `exactOptionalPropertyTypes: true` callers in the sheets / docs
 * Electron builds.
 */

export type LanguageCode =
  | 'auto'
  | 'zh-CN'
  | 'zh-TW'
  | 'en-US'
  | 'ja-JP'
  | 'ko-KR'
  | 'fr-FR'
  | 'de-DE'
  | 'es-ES'
  | 'it-IT'
  | 'pt-PT'
  | 'ru-RU'
  | 'ar-SA'
  | 'hi-IN'
  | 'th-TH'

export interface LanguageOption {
  value: LanguageCode
  label: string
  englishLabel: string
}

export interface EditorRange {
  from?: number | undefined
  to?: number | undefined
  scope?: 'selection' | 'document' | 'paragraph' | 'cell' | 'table' | undefined
}

export interface TranslationUnit {
  unitId: string
  kind: 'paragraph' | 'heading' | 'list-item' | 'table-cell' | 'document'
  sourceText: string
  order: number
  range?: EditorRange | null | undefined
  metadata?: Record<string, unknown> | undefined
}

export interface TranslateRequest {
  instruction: string
  sourceLang?: LanguageCode | string | undefined
  targetLang: LanguageCode | string
  preserveFormat?: boolean | undefined
  range?: EditorRange | null | undefined
  /** When false the shared TM is skipped (default true). */
  memoryEnabled?: boolean | undefined
  /** When false the post-translation quality assessment is skipped (default true). */
  qualityCheck?: boolean | undefined
  /** Free-form bucket label (e.g. 'legal', 'finance') for memory grouping. */
  glossaryCategory?: string | undefined
  /** Customer name — forwarded to the KB resolver so per-customer terms
   *  (and customerPreference entries) narrow the prompt + matchedTerms. */
  customerName?: string | undefined
  /**
   * Bucket for the translation-memory cache. Takes precedence over
   * `glossaryCategory` / `customerName` when deriving the memory bucket.
   *
   * Carried on the single-unit request too because `translateBatch` /
   * `translateBatchStream` settle each unit through `translateOne`, which is
   * where `memory.save` happens: the write must land in the same bucket the
   * batch-level `memory.lookup` searched, or the entry is never found again.
   */
  cacheScope?: string | undefined
}

export interface TranslateResponse {
  ok: boolean
  translated?: string | undefined
  planId?: string | undefined
  error?: string | undefined
  sourceLang?: string | undefined
  targetLang?: string | undefined
  preserveFormat?: boolean | undefined
  status?: 'translated' | 'memory-hit' | 'failed' | undefined
  matchedTerms?: string[] | undefined
  warnings?: string[] | undefined
}

/**
 * One caller-supplied `source -> target` pair, carried inline on the request.
 *
 * Structurally identical to `TerminologyPair` (`kb-rules.ts`), but declared
 * here because this is the **wire** shape: hosts serialise it to JSON without
 * importing translation-core internals.
 */
export interface InlineGlossaryPair {
  source: string
  target: string
}

/** One caller-supplied translation-memory entry, carried inline on the request. */
export interface InlineMemoryEntry {
  sourceText: string
  targetText: string
  /** Free-form label (scene, document id, …); not used for matching today. */
  context?: string | undefined
}

export interface TranslateBatchRequest {
  units: TranslationUnit[]
  sourceLang?: LanguageCode | string | undefined
  targetLang: LanguageCode | string
  preserveFormat?: boolean | undefined
  scene?: string | undefined
  /** When false the shared TM is skipped (default true). */
  memoryEnabled?: boolean | undefined
  /** When false the post-translation quality assessment is skipped (default true). */
  qualityCheck?: boolean | undefined
  /** Free-form bucket label for memory grouping / routing. */
  glossaryCategory?: string | undefined
  /** Customer name — forwarded to the KB resolver so per-customer terms
   *  (and customerPreference entries) narrow the result set. */
  customerName?: string | undefined
  /**
   * Request-scoped mandatory term pairs, layered on top of the KB terms.
   *
   * Hosts that keep their term store outside GenOffice (a database, a
   * SaaS tenant dictionary) send the applicable rows with every call instead
   * of a sync protocol. Merged with the KB terms; longest source wins.
   *
   * Kept generic (no tenant semantics) so translation-core stays free of any
   * host's data model.
   */
  glossary?: readonly InlineGlossaryPair[] | undefined
  /**
   * Request-scoped translation-memory entries, consulted **before** the LLM.
   *
   * Exact-match only, and only for this request — these are never written
   * back to any shared store. A hit short-circuits the provider call.
   */
  memory?: readonly InlineMemoryEntry[] | undefined
  /**
   * Bucket for the translation-memory cache. Takes precedence over
   * `glossaryCategory` / `customerName` when deriving the memory bucket.
   *
   * Hosts that serve multiple tenants **must** set this to a per-tenant value:
   * the server-wide persistent TM is shared across requests, so an unscoped
   * bucket lets one tenant's translation be replayed for another.
   */
  cacheScope?: string | undefined
}

export interface TranslateBatchUnitResult {
  unitId: string
  sourceText: string
  translatedText?: string | undefined
  status?: 'translated' | 'memory-hit' | 'failed' | undefined
  matchedTerms?: string[] | undefined
  warnings?: string[] | undefined
  errorMessage?: string | undefined
  range?: EditorRange | null | undefined
}

export interface TranslateBatchResponse {
  ok: boolean
  units?: TranslateBatchUnitResult[] | undefined
  quality?: { overallScore?: number | undefined; warnings?: string[] | undefined } | undefined
  error?: string | undefined
}

export interface QualityReport {
  overallScore: number
  warnings: string[]
  empty?: boolean
  untranslated?: boolean
}
