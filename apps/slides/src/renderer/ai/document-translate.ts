/**
 * Whole-deck translation for the slides app.
 *
 * Same shape as the sheets adapter: extraction and write-back are the two
 * host-specific halves of the shared pipeline in
 * `@genoffice/translation-core/document`, and batching / progress / quality /
 * cancel are inherited from it.
 *
 * Two things this module deliberately does **not** do, because doing them
 * halfway is worse than not doing them:
 *
 *   - **It does not re-layout text.** A `RenderTextLayout` is the *output* of
 *     the layout engine; hand-patching `lines[]` would leave `contentHeight`,
 *     `inkBottom` and the autofit scale describing the old text. The write-back
 *     therefore goes through the app's real `slides:edit-text` op, which
 *     re-runs layout and returns a fresh slide.
 *   - **It does not touch table cells.** That op addresses a text frame by
 *     `sourceId`; a single table cell is a different write path
 *     (`EditingCellState` + `commitCellEdit`) with no whole-table form yet.
 *     Translating them through the text-frame op would write to the wrong
 *     place, so cells are left alone and reported as skipped.
 *
 * Bilingual mode renders as "原文段落 + 译文段落" inside the same text frame.
 * The obvious alternative — a second text box beside the original — needs a
 * shape-insert op the slides API does not have, and inventing one here would
 * be a much larger change than the translation work it serves.
 */

import {
  translateDocument,
  type TranslateApplyMode,
  type TranslateBatchFn,
  type TranslateBatchRequest,
  type TranslateBatchResponse,
  type TranslateBatchUnitResult,
  type TranslateProgress,
  type TranslateProgressStatus,
  type TranslatedUnit,
  type TranslationUnit,
} from '@genoffice/translation-core/document'

/** The render-tree slices this module reads. Structural, so callers cast. */
export interface SlideTextLineLike {
  runs?: Array<{ text?: string; isBullet?: boolean }> | undefined
  paraStart?: boolean | undefined
  /** Whitespace the layout engine swallowed at the wrap point. */
  trailingSpace?: boolean | undefined
  /** The exact swallowed whitespace; absent on stored decks → one space. */
  trailingText?: string | undefined
  /** The line ends with a soft `<a:br/>` break. */
  softBreakAfter?: number | undefined
}

export interface SlideTextLike {
  lines?: readonly SlideTextLineLike[] | undefined
}

export interface SlideNodeLike {
  id?: string
  type?: string
  sourceId?: string
  decoration?: boolean
  text?: SlideTextLike | undefined
  children?: readonly SlideNodeLike[] | undefined
}

export interface SlideLike {
  nodes: readonly SlideNodeLike[]
}

/** A translatable text frame, located well enough to write back. */
export interface DeckTextUnitSource {
  slideIndex: number
  sourceId: string
  /** Enclosing group ids, outermost first — `editText` addresses one at a time. */
  groupPath: readonly string[]
  text: string
}

export interface DeckTextNode extends DeckTextUnitSource {
  unitId: string
  order: number
}

/** Ceiling on text frames per run; a 2000-slide deck would otherwise never finish. */
export const MAX_TRANSLATE_FRAMES = 5_000

/** Longest single frame worth translating. */
export const MAX_TRANSLATE_FRAME_CHARS = 8_000

/**
 * Reconstruct a text frame's plain text from its laid-out lines.
 *
 * `paraStart` marks where the *model* paragraph begins; a line without it is an
 * auto-wrap continuation and must be joined with a space (or, for CJK, with
 * nothing) rather than treated as a new paragraph. Getting this wrong turns one
 * wrapped sentence into three "paragraphs" that the model then translates as
 * three unrelated fragments.
 */
export function frameText(lines: readonly SlideTextLineLike[] | undefined): string {
  if (!lines || lines.length === 0) return ''
  const parts: string[] = []
  for (const [index, line] of lines.entries()) {
    // `isBullet` runs are the glyph the layout engine *injected* for a buChar /
    // buAutoNum paragraph — they are not model text. Reading them back would feed
    // "• Purchase order" to the model and, on write-back, write the glyph into
    // the model text while the paragraph still carries `buChar`, doubling it.
    // Every other extractor in the app (FindReplaceDialog, style-actions, the
    // skill) filters on the same flag; this one originally didn't.
    const text = (line.runs ?? [])
      .filter((run) => !run.isBullet)
      .map((run) => run.text ?? '')
      .join('')
    if (index === 0 || line.paraStart) {
      parts.push(text)
      continue
    }
    // An auto-wrap continuation rejoins the current paragraph. The layout
    // engine swallows the space at the wrap point and records it on the
    // *previous* line, so it has to be re-inserted here — joining with ''
    // would glue two words together ("First parawrapped"), and joining with a
    // hard space would corrupt CJK lines, which wrap without one.
    const previous = lines[index - 1]!
    const swallowed = previous.trailingSpace ? (previous.trailingText ?? ' ') : ''
    parts[parts.length - 1] = `${parts[parts.length - 1]}${swallowed}${text}`
  }
  return parts.join('\n').trim()
}

export function isTranslatableFrameText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return false
  return trimmed.length <= MAX_TRANSLATE_FRAME_CHARS
}

/**
 * Collect every translatable text frame of a deck, in slide then z-order.
 *
 * Skips `decoration` nodes: those come from the master/layout, are flagged
 * read-only, and writing to them would fail or — worse — be silently dropped
 * while the run reported success.
 */
export function extractDeckTextFrames(slides: readonly SlideLike[]): DeckTextNode[] {
  const found: DeckTextNode[] = []
  const visit = (
    nodes: readonly SlideNodeLike[],
    slideIndex: number,
    groupPath: string[],
  ): void => {
    for (const node of nodes) {
      if (node.decoration) continue
      if (node.type === 'group' && node.children) {
        const nextPath = node.id ? [...groupPath, node.id] : groupPath
        visit(node.children, slideIndex, nextPath)
        continue
      }
      if (node.type === 'table') {
        // Cell write-back has no whole-table op yet; see the module docblock.
        continue
      }
      const text = frameText(node.text?.lines)
      if (!isTranslatableFrameText(text)) continue
      const sourceId = node.sourceId ?? node.id
      if (!sourceId) continue
      found.push({
        slideIndex,
        sourceId,
        groupPath: [...groupPath],
        text,
        // `#` separates the three address components, so each id is
        // percent-encoded: a durable id that itself contains `#` would
        // otherwise be unparseable, and the review step could no longer tell
        // which frame a translation belongs to.
        unitId: `slide${slideIndex}#${groupPath.map(encodeURIComponent).join('/')}#${encodeURIComponent(sourceId)}`,
        order: found.length,
      })
      if (found.length > MAX_TRANSLATE_FRAMES) {
        throw new Error(`幻灯片文本框超过 ${MAX_TRANSLATE_FRAMES} 个，请先选中要翻译的区域再试`)
      }
    }
  }
  slides.forEach((slide, slideIndex) => visit(slide.nodes ?? [], slideIndex, []))
  return found
}

/** Map frames onto the pipeline's extraction order. */
export function deckFramesToUnits(frames: readonly DeckTextNode[]): TranslationUnit[] {
  return frames.map((frame) => ({
    unitId: frame.unitId,
    order: frame.order,
    kind: (frame.text.length > 120 ? 'paragraph' : 'heading') as TranslationUnit['kind'],
    sourceText: frame.text,
    metadata: {
      slideIndex: frame.slideIndex,
      sourceId: frame.sourceId,
      groupPath: frame.groupPath,
    },
  }))
}

export interface DeckTranslateWrite {
  slideIndex: number
  sourceId: string
  groupPath: readonly string[]
  text: string
}

/**
 * The transport the deck UI injects — the shared pipeline's own
 * {@link TranslateBatchFn} signature, re-exported under a deck-flavoured name
 * so the dialog props and the App wiring read as one concept. Declared with the
 * same optional parameters on purpose: a required-signal variant is not
 * assignable to the core's type, and widening the core instead would change
 * every other application.
 */
export type DeckTranslateBatchFn = (
  request: TranslateBatchRequest,
  signal?: AbortSignal,
  onUnit?: (unit: TranslateBatchUnitResult) => void,
) => Promise<TranslateBatchResponse>

export interface DeckTranslateDeps {
  slides: readonly SlideLike[]
  translateBatch: DeckTranslateBatchFn
  /**
   * Write one frame back, through the app's real edit op.
   *
   * Async because that op round-trips to the main process and re-runs layout;
   * the pipeline awaits it, so a frame that fails to write fails the run
   * instead of leaving a deck that is half old and half new.
   */
  writeFrame: (write: DeckTranslateWrite) => Promise<void>
  onProgress?: ((progress: TranslateProgress) => void | Promise<void>) | undefined
}

export interface DeckTranslateOptions {
  targetLang: string
  sourceLang?: string | undefined
  applyMode?: TranslateApplyMode | undefined
  memoryEnabled?: boolean | undefined
  qualityCheck?: boolean | undefined
  glossaryCategory?: string | undefined
  scene?: string | undefined
  signal?: AbortSignal | undefined
}

/** Compose the final text for one frame, given the apply mode. */
export function composeFrameText(
  source: string,
  translation: string,
  mode: TranslateApplyMode,
): string {
  if (mode !== 'bilingual') return translation
  const trimmedSource = source.trim()
  if (trimmedSource === '') return translation
  return `${trimmedSource}\n${translation}`
}

export async function translateDeckDocument(
  deps: DeckTranslateDeps,
  options: DeckTranslateOptions,
): Promise<{
  status: TranslateProgressStatus
  mode: TranslateApplyMode
  units: TranslatedUnit[]
  quality?: { overallScore?: number; warnings?: string[] } | undefined
  error?: string | undefined
}> {
  const frames = extractDeckTextFrames(deps.slides)
  const units = deckFramesToUnits(frames)
  const mode: TranslateApplyMode = options.applyMode ?? 'replace'
  const byId = new Map(frames.map((frame) => [frame.unitId, frame]))

  const run = await translateDocument(
    {
      units,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      preserveFormat: true,
      memoryEnabled: options.memoryEnabled,
      qualityCheck: options.qualityCheck,
      glossaryCategory: options.glossaryCategory,
      scene: options.scene ?? 'deck-document',
      applyMode: mode,
    },
    {
      translateBatch: deps.translateBatch,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      apply: async ({ units: settled }) => {
        for (const unit of settled) {
          const frame = byId.get(unit.unitId)
          if (!frame) continue
          await deps.writeFrame({
            slideIndex: frame.slideIndex,
            sourceId: frame.sourceId,
            groupPath: frame.groupPath,
            text: composeFrameText(frame.text, unit.translatedText, mode),
          })
        }
      },
    },
  )

  return {
    status: run.status,
    mode: run.mode,
    units: run.units,
    // The pipeline only reports quality when at least one batch returned a
    // score; `undefined` here means "not measured", which the dialog renders as
    // no badge rather than as a zero score.
    quality: run.quality,
    ...(run.error !== undefined ? { error: run.error } : {}),
  }
}

/**
 * Recover a frame's address from a unit id produced by
 * {@link extractDeckTextFrames}.
 *
 * The review-then-apply flow needs this: the dialog runs the pipeline with a
 * no-op `writeFrame` and hands the write back as a flat `{ unitId, … }` list,
 * so the address has to survive the round trip through the UI. Re-deriving it
 * from the *current* deck instead would silently mis-target every frame if the
 * user reordered or deleted a slide while the dialog was open.
 *
 * Ids are minted as `slide<n>#<groupPath joined by />#<sourceId>` with each id
 * percent-encoded, so neither component can contain the separator.
 *
 * Returns `null` for an id that is not one of ours — or for a malformed
 * percent-escape, which is the same class of "someone else's string" and must
 * not be decoded on a guess. The caller drops such a unit rather than
 * guessing a target, because writing to the wrong text frame is worse than not
 * writing at all.
 */
export function parseDeckUnitId(
  unitId: string,
): { slideIndex: number; sourceId: string; groupPath: string[] } | null {
  const match = unitId.match(/^slide(\d+)#(.*)#([^#]+)$/)
  if (!match) return null
  const slideIndex = Number(match[1])
  if (!Number.isInteger(slideIndex) || slideIndex < 0) return null
  const groupSegment = match[2] ?? ''
  const sourceId = match[3] ?? ''
  if (sourceId === '') return null
  try {
    return {
      slideIndex,
      sourceId: decodeURIComponent(sourceId),
      groupPath: groupSegment === '' ? [] : groupSegment.split('/').map(decodeURIComponent),
    }
  } catch {
    return null
  }
}
