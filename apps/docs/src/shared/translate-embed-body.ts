/**
 * Wire-body builder for the embedded (Dataflare-hosted) translation branches
 * of `web-bridge.ts`.
 *
 * Extracted from `web-bridge.ts` so the three embedded call sites (one-shot,
 * batch, SSE batch) can share one implementation and be unit-tested without
 * booting the whole renderer bridge.
 *
 * Why this exists: the three branches each built their own body, and all three
 * hard-coded `memoryEnabled: true` / `qualityCheck: true` while never sending
 * `glossaryCategory` / `customerName`. The web-server endpoint understands all
 * four fields (see `apps/web-server/src/ai/translate-http.ts`), so an embedded
 * user who turned memory off still got memory lookups, turned quality off and
 * still got warnings, and — the costly one — a customer-scoped document was
 * translated with every customer's glossary in the prompt.
 */

export interface EmbedTranslateUnitInput {
  unitId: string
  kind: string
  sourceText: string
  order?: number | undefined
  path?: string | undefined
  metadata?: Record<string, unknown> | undefined
  range?: { from?: number; to?: number; scope?: string } | null | undefined
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
