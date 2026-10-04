/**
 * Whole-document / selection translation for the markdown app.
 *
 * The shared pipeline in `@genoffice/translation-core/document` owns batching,
 * per-unit retry, checkpoint resume, quality checks and cancel semantics. This
 * module supplies the two host-specific halves for a markdown document:
 *
 *   · **extract** — walk the ProseMirror tree and take every *textblock*
 *     (paragraph / heading / list-item / table cell) as one unit;
 *   · **apply**   — build the same `MdOp` vocabulary the AI's `apply_ops` tool
 *     and the UI use, and run it through `runOps`. Reusing the op layer (rather
 *     than dispatching transactions directly) is what keeps a translated
 *     document's structure, marks, lists and tables byte-identical to what the
 *     manual/AI editors would have produced.
 *
 * Two rules that are not negotiable, because breaking them corrupts a user's
 * document rather than merely mistranslating it:
 *   · code blocks and frontmatter are **never** translated — a translated
 *     `codeBlock` is a broken program, and frontmatter is document metadata;
 *   · a bilingual run never overwrites the source: it inserts a translated
 *     paragraph after the block it belongs to.
 */

import type { Editor } from '@tiptap/core'
import {
  translateDocument,
  type TranslateApplyMode,
  type TranslateBatchFn,
  type TranslateCheckpoint,
  type TranslateDocumentResult,
  type TranslateProgress,
  type TranslateRetryPolicy,
  type TranslatedUnit,
  type TranslationUnit,
} from '@genoffice/translation-core/document'
import {
  blockIndexRange,
  runOps,
  selectionBlockRange,
  type MdOp,
  type RunOpsResult,
} from '../editor/ops'

/**
 * The slice of a ProseMirror node this module needs.
 *
 * Declared structurally instead of importing `@tiptap/pm/model` so the extract
 * rules can be unit-tested against a plain object, and so the module stays
 * importable from a bundle that never touches the ProseMirror model package.
 * A real `Node` satisfies it as-is.
 */
export interface PmNodeLike {
  readonly type: { name: string }
  readonly textContent: string
  readonly isTextblock?: boolean
  forEach(callback: (node: PmNodeLike, offset: number, index: number) => void): void
}

/** Node types whose text is content, not prose. */
const SKIP_BLOCK_TYPES: ReadonlySet<string> = new Set(['codeBlock', 'frontmatter', 'horizontalRule'])

/**
 * Ceiling on the blocks one run will translate.
 *
 * A generated 200k-line document would otherwise fan out into thousands of
 * provider calls with no way to stop. Hitting it is reported as a `failed` run
 * naming the number — never a silent truncation, because a half-translated
 * document that reports success is the one outcome a user cannot detect.
 */
export const MAX_TRANSLATE_BLOCKS = 5_000

/** A translatable block, carrying the coordinate the write-back ops address. */
export interface MarkdownTextBlock {
  /**
   * 0-based **top-level** block index — the same coordinate `MdOp.target`
   * takes, so extraction and apply cannot drift apart over an off-by-one.
   */
  blockIndex: number
  kind: TranslationUnit['kind']
  text: string
}

/** Optional top-level block window (inclusive), used for selection runs. */
export interface BlockIndexWindow {
  startIndex: number
  endIndex: number
}

function kindOf(node: PmNodeLike, hint: TranslationUnit['kind']): TranslationUnit['kind'] {
  if (node.type.name === 'heading') return 'heading'
  return hint
}

/** Container types that decide the *kind* of the textblocks nested inside them. */
const CONTAINER_KINDS: Record<string, TranslationUnit['kind']> = {
  listItem: 'list-item',
  tableCell: 'table-cell',
  tableHeader: 'table-cell',
}

function collectTextblocks(
  node: PmNodeLike,
  blockIndex: number,
  hint: TranslationUnit['kind'],
  out: MarkdownTextBlock[],
): void {
  if (SKIP_BLOCK_TYPES.has(node.type.name)) return
  if (node.isTextblock) {
    const text = node.textContent.trim()
    if (text !== '') out.push({ blockIndex, kind: kindOf(node, hint), text })
    return
  }
  // The kind comes from the *container*, not from the textblock's own type: a
  // table cell and a list item both hold ordinary `paragraph` nodes, and the
  // kind travels into the prompt (and the quality rules) so a short list
  // fragment is not judged by the long-paragraph rules.
  const nextHint: TranslationUnit['kind'] = CONTAINER_KINDS[node.type.name] ?? hint
  node.forEach((child) => collectTextblocks(child, blockIndex, nextHint, out))
}

/**
 * Collect every translatable textblock of the document, in document order.
 *
 * Throws (rather than truncating) past {@link MAX_TRANSLATE_BLOCKS}; the caller
 * turns that into a visible `failed` run.
 */
export function extractMarkdownTextBlocks(
  doc: PmNodeLike,
  window?: BlockIndexWindow | undefined,
): MarkdownTextBlock[] {
  const blocks: MarkdownTextBlock[] = []
  doc.forEach((node, _offset, index) => {
    if (window && (index < window.startIndex || index > window.endIndex)) return
    if (blocks.length > MAX_TRANSLATE_BLOCKS) {
      throw new Error(
        `文档可翻译块超过 ${MAX_TRANSLATE_BLOCKS} 个，请先选中要翻译的范围再试`,
      )
    }
    collectTextblocks(node, index, 'paragraph', blocks)
  })
  return blocks
}

/**
 * The top-level block window covered by the current selection.
 *
 * Reuses the editor's own selection→block mapping so a selection run targets
 * exactly the blocks the UI highlights — a second implementation of that rule
 * is how a "translate selection" ends up changing the block next to the caret.
 */
export function selectionBlockWindow(editor: Editor): BlockIndexWindow {
  const range = selectionBlockRange(editor)
  return blockIndexRange(editor.state.doc, range.from, range.to)
}

/**
 * Map blocks onto the pipeline's extraction order.
 *
 * `blockIndex` travels in the unit id as well as the metadata: the review-then-
 * apply flow hands the write back as a flat list of settled units, and parsing
 * the id we minted is the honest way to recover the target block — re-deriving
 * it from the *current* document would silently mis-target every unit if the
 * user edited the document while the run was in flight.
 */
export function markdownBlocksToUnits(blocks: readonly MarkdownTextBlock[]): TranslationUnit[] {
  return blocks.map((block, order) => ({
    unitId: `md:${block.blockIndex}:${order}`,
    order,
    kind: block.kind,
    sourceText: block.text,
    metadata: { blockIndex: block.blockIndex },
  }))
}

/** Recover the target block index from a unit id produced by {@link markdownBlocksToUnits}. */
export function parseMarkdownUnitId(unitId: string): { blockIndex: number } | null {
  const match = /^md:(\d+):(\d+)$/.exec(unitId)
  if (!match) return null
  const blockIndex = Number(match[1])
  return Number.isInteger(blockIndex) ? { blockIndex } : null
}

function blockIndexOf(unit: TranslatedUnit): number {
  const metadata = unit.metadata as { blockIndex?: unknown } | undefined
  const fromMetadata = Number(metadata?.blockIndex)
  if (Number.isInteger(fromMetadata)) return fromMetadata
  const parsed = parseMarkdownUnitId(unit.unitId)
  if (parsed) return parsed.blockIndex
  throw new Error(`翻译单元 ${unit.unitId} 缺少块坐标，拒绝回写以免写错位置`)
}

/**
 * Build the write-back ops for a settled run.
 *
 * `replace` rewrites each block's text in place through `replaceText`, which
 * keeps the block's type, marks and nesting; `bilingual` leaves the source
 * untouched and inserts one translated paragraph after each block that carries
 * a unit. Exported (and pure) so both rules are testable without running the
 * pipeline — and so the dialog's review-then-apply step and the inline apply
 * cannot drift into two different answers.
 */
export function buildMarkdownApplyOps(
  units: readonly TranslatedUnit[],
  mode: TranslateApplyMode,
): MdOp[] {
  const settled = units.filter(
    (unit) => typeof unit.translatedText === 'string' && unit.translatedText.trim() !== '',
  )
  if (mode === 'bilingual') {
    const byBlock = new Map<number, string[]>()
    for (const unit of settled) {
      const blockIndex = blockIndexOf(unit)
      const list = byBlock.get(blockIndex)
      if (list) list.push(unit.translatedText)
      else byBlock.set(blockIndex, [unit.translatedText])
    }
    return [...byBlock.entries()].map(([blockIndex, translations]) => ({
      op: 'insertContent' as const,
      // "after" accepts a block index; one batched op per source block, so a
      // list item with three paragraphs gets one translated paragraph, not
      // three half-sentences.
      after: blockIndex,
      markdown: translations.join('\n\n'),
    }))
  }
  return settled.map((unit) => ({
    op: 'replaceText' as const,
    target: { start: blockIndexOf(unit), end: blockIndexOf(unit) },
    find: unit.sourceText,
    replace: unit.translatedText,
  }))
}

/**
 * Write settled translations into the editor.
 *
 * Goes through `runOps` — the same dispatcher behind the `apply_ops` tool and
 * the manual editing UI — so the result is a normal, undoable document edit.
 * `ReplaceAll` semantics of the op layer (`find` must match inside the target
 * block) also mean a run that settles against a stale extraction fails loudly
 * per op instead of writing a translation into the wrong block.
 */
export function applyMarkdownTranslations(
  editor: Editor,
  units: readonly TranslatedUnit[],
  mode: TranslateApplyMode,
): RunOpsResult {
  const ops = buildMarkdownApplyOps(units, mode)
  if (ops.length === 0) return { results: [], applied: 0, blocksChanged: false }
  return runOps(editor, ops, { source: 'ai' })
}

export interface MarkdownTranslateOptions {
  targetLang: string
  sourceLang?: string | undefined
  /** Defaults to `replace`. */
  applyMode?: TranslateApplyMode | undefined
  /** `selection` translates only the blocks the current selection covers. */
  scope?: 'document' | 'selection' | undefined
  preserveFormat?: boolean | undefined
  memoryEnabled?: boolean | undefined
  qualityCheck?: boolean | undefined
  glossaryCategory?: string | undefined
  scene?: string | undefined
  signal?: AbortSignal | undefined
  checkpoint?: TranslateCheckpoint | undefined
  retry?: TranslateRetryPolicy | undefined
  maxUnitsPerBatch?: number | undefined
}

export interface MarkdownTranslateDeps {
  editor: Editor
  /** Injected transport — the renderer reaches the provider through the bridge. */
  translateBatch: TranslateBatchFn
  /**
   * Override the write-back. A review-then-apply UI passes a no-op here and
   * performs the same write later through {@link applyMarkdownTranslations}, so
   * both paths share one "where does a translation go" implementation.
   */
  apply?:
    | ((context: { units: TranslatedUnit[]; mode: TranslateApplyMode }) => void | Promise<void>)
    | undefined
  onProgress?: ((progress: TranslateProgress) => void | Promise<void>) | undefined
}

/**
 * Translate the whole document (or the selection) through the shared pipeline.
 *
 * Returns the pipeline's result verbatim so the caller can report
 * `completed` / `completed-with-failures` / `failed` / `cancelled` without
 * re-deriving them. A cancelled run writes nothing.
 */
export async function translateMarkdownDocument(
  deps: MarkdownTranslateDeps,
  options: MarkdownTranslateOptions,
): Promise<TranslateDocumentResult> {
  const { editor } = deps
  const window = options.scope === 'selection' ? selectionBlockWindow(editor) : undefined
  const blocks = extractMarkdownTextBlocks(editor.state.doc, window)
  const units = markdownBlocksToUnits(blocks)
  const mode: TranslateApplyMode = options.applyMode ?? 'replace'

  return translateDocument(
    {
      units,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      preserveFormat: options.preserveFormat,
      scene: options.scene ?? 'markdown-document',
      memoryEnabled: options.memoryEnabled,
      qualityCheck: options.qualityCheck,
      glossaryCategory: options.glossaryCategory,
      applyMode: mode,
    },
    {
      translateBatch: deps.translateBatch,
      // `exactOptionalPropertyTypes` is on in this app: an absent callback has
      // to be *absent*, not explicitly `undefined`.
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
      ...(options.retry ? { retry: options.retry } : {}),
      ...(options.maxUnitsPerBatch ? { maxUnitsPerBatch: options.maxUnitsPerBatch } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      apply:
        deps.apply ??
        (({ units: settled, mode: appliedMode }) => {
          applyMarkdownTranslations(editor, settled, appliedMode)
        }),
    },
  )
}
