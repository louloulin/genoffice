/**
 * Whole-document / selection translation for the html app.
 *
 * The shared pipeline in `@genoffice/translation-core/document` owns batching,
 * per-unit retry, checkpoint resume, quality checks and cancel semantics. This
 * module supplies the two host-specific halves for an html document:
 *
 *   · **extract** — take every translatable *text node* of the parse map, in
 *     document order (the parse map already carries each element's direct
 *     child text nodes with their exact source offsets);
 *   · **apply**   — build the same `HtmlOp` vocabulary the AI's `apply_ops` tool
 *     and the manual UI compile, so a translated document is a normal edit the
 *     CodeMirror buffer, the undo stack and the preview all understand.
 *
 * Three rules that are not negotiable, because breaking them corrupts a user's
 * document rather than merely mistranslating it:
 *   · script / style / code / pre content is **never** translated — a translated
 *     `<script>` is a broken program;
 *   · a write-back addresses the text node by the coordinate the *extraction*
 *     saw (`sid` + child index), never by re-deriving it from the live
 *     document — an edit during the run would silently retarget every unit;
 *   · the whitespace that separates a text node from its inline siblings is
 *     part of the document, so it is carried through the round-trip rather than
 *     trimmed away.
 */

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
import type { ParseMap } from '../document/parse-map'
import { escapeText, type HtmlOp, type OpError } from '../document/ops'

/**
 * The element whose own text is content, not prose. Their text nodes are
 * skipped by extraction *and* by the block walk that picks a bilingual anchor:
 * a `<pre>` nested in a section must not make the section look like it starts
 * with code.
 */
const SKIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'title',
  'textarea',
  'code',
  'pre',
  'kbd',
  'samp',
  'var',
  'svg',
  'math',
  'canvas',
  'iframe',
  'object',
  'select',
  'datalist',
])

/**
 * Elements a bilingual run can be inserted *after* by reusing the tag: they
 * already live at that position, so a second one is valid by construction
 * (a `<p>` after a `<p>`, a `<td>` after a `<td>`, an `<li>` after an `<li>`).
 */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'dt',
  'dd',
  'blockquote',
  'figcaption',
  'caption',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'address',
  'form',
  'label',
  'summary',
])

/**
 * Structural tags whose own text is not a prose block, so a translation
 * inserted after them must not reuse the tag: a second `<body>` or a `<p>`
 * inside `<tr>` is either invalid or gets foster-parented out of the table.
 * The fallback `<p>` is valid wherever these bubble up.
 */
const STRUCTURAL_TAGS: ReadonlySet<string> = new Set([
  'html',
  'head',
  'body',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'colgroup',
  'col',
  'ul',
  'ol',
  'dl',
  'figure',
  'picture',
  'optgroup',
])

const INSERT_TAG_FALLBACK = 'p'

/**
 * A tag boundary, the way HTML tokenizes one: `<` followed by `/`, a letter,
 * `!` or `?`. A `<` followed by anything else (a space, a digit) is ordinary
 * text — `a < b` is prose, and parse5 keeps such a `<` inside the text node.
 */
const TAG_LIKE = /<\/?[a-zA-Z!?]/

/**
 * Ceiling on the text nodes one run will translate.
 *
 * A machine-generated page would otherwise fan out into thousands of provider
 * calls with no way to stop. Hitting it is reported as a `failed` run naming
 * the number — never a silent truncation, because a half-translated document
 * that reports success is the one outcome a user cannot detect.
 */
export const MAX_TRANSLATE_NODES = 5_000

/** A translatable text node, carrying the coordinate the write-back addresses. */
export interface HtmlTextNode {
  /** owning element id in the parse map */
  sid: number
  /** index of the text node among the element's direct child text nodes */
  index: number
  /** owning element's tag, lowercased */
  tag: string
  /** the element a bilingual translation is inserted after (nearest block ancestor) */
  blockSid: number
  blockTag: string
  /** decoded text, whitespace trimmed */
  text: string
  /** whitespace that separated this node from its siblings: restored on replace */
  lead: string
  trail: string
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×',
  divide: '÷',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  sect: '§',
  para: '¶',
  bull: '•',
}

/**
 * Decode the character references of a source text node.
 *
 * The translation is sent the *rendered* text, not the markup: an author who
 * wrote `&amp;` sees `&`, and the write-back escapes it again through the same
 * `escapeText` the op layer uses, so the round-trip is lossless. Numeric
 * references are decoded by value; named ones fall back to a small table of
 * what actually appears in prose, and anything unknown is left verbatim rather
 * than dropped.
 */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw
  return raw.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(Math.min(code, 0x10ffff)) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(Math.min(code, 0x10ffff)) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

function kindOf(tag: string): TranslationUnit['kind'] {
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'li') return 'list-item'
  if (tag === 'td' || tag === 'th') return 'table-cell'
  return 'paragraph'
}

/** The element a bilingual translation is inserted after: the node's own block, or its nearest block ancestor. */
function blockAnchor(map: ParseMap, sid: number): { sid: number; tag: string } {
  let cur = map.bySid.get(sid)
  let first: { sid: number; tag: string } | null = null
  while (cur) {
    if (SKIP_TAGS.has(cur.tag)) return first ?? { sid, tag: cur.tag }
    if (STRUCTURAL_TAGS.has(cur.tag)) return { sid: cur.sid, tag: cur.tag }
    if (BLOCK_TAGS.has(cur.tag)) return { sid: cur.sid, tag: cur.tag }
    if (!first) first = { sid: cur.sid, tag: cur.tag }
    if (cur.parentSid === null) break
    cur = map.bySid.get(cur.parentSid)
  }
  return first ?? { sid, tag: cur?.tag ?? '' }
}

export interface HtmlExtractWindow {
  /** restrict extraction to one text node (a selection run) */
  sid: number
  index: number
}

/**
 * Collect every translatable text node of the document, in document order.
 *
 * Throws (rather than truncating) past {@link MAX_TRANSLATE_NODES}; the caller
 * turns that into a visible `failed` run.
 */
export function extractHtmlTextNodes(
  text: string,
  map: ParseMap,
  window?: HtmlExtractWindow | undefined,
): HtmlTextNode[] {
  // Collected with each node's source offset, then sorted: `map.elements` walks
  // the tree element-by-element, so an element's own trailing text node
  // (`<p>Inline <b>bold</b> tail</p>` → `tail`) would otherwise be emitted
  // *before* the inline `<b>`'s node. Replace writes by coordinate and does not
  // care, but a bilingual run joins a block's fragments in this order, so
  // element-major output would assemble `[Inline] [tail] [bold]` — a translated
  // sentence with its words permuted.
  const collected: Array<{ node: HtmlTextNode; start: number }> = []
  for (const element of map.elements) {
    if (SKIP_TAGS.has(element.tag)) continue
    for (let index = 0; index < element.textNodes.length; index++) {
      const range = element.textNodes[index]!
      if (window && (element.sid !== window.sid || index !== window.index)) continue
      if (collected.length > MAX_TRANSLATE_NODES) {
        throw new Error(
          `文档可翻译文本节点超过 ${MAX_TRANSLATE_NODES} 个，请先选中要翻译的范围再试`,
        )
      }
      const raw = text.slice(range[0], range[1])
      // parse5 appends the whitespace after `</body>` to body's *last* text node
      // but gives that node a location spanning the closing tags, so the slice is
      // not always the node's own source: for a document ending `</body>\n</html>`
      // it is `\n</body>\n</html>\n`. Rewriting that range would delete the end
      // tags — the one failure a user cannot detect. A range whose source
      // contains a tag boundary is not a text node, so it is not translatable.
      if (TAG_LIKE.test(raw)) continue
      const decoded = decodeEntities(raw)
      const body = decoded.trim()
      // Nothing to translate: whitespace between elements, a bare number, or
      // pure punctuation would only burn a provider call to come back identical.
      if (body === '' || !/\p{L}/u.test(body)) continue
      const lead = decoded.slice(0, decoded.indexOf(body))
      const trail = decoded.slice(lead.length + body.length)
      const anchor = blockAnchor(map, element.sid)
      collected.push({
        start: range[0],
        node: {
          sid: element.sid,
          index,
          tag: element.tag,
          blockSid: anchor.sid,
          blockTag: anchor.tag,
          text: body,
          lead,
          trail,
        },
      })
    }
  }
  collected.sort((a, b) => a.start - b.start)
  return collected.map((entry) => entry.node)
}

/**
 * Map text nodes onto the pipeline's extraction order.
 *
 * The coordinate travels in the unit id as well as the metadata: a review-then-
 * apply flow hands the write back as a flat list of settled units, and parsing
 * the id we minted is the honest way to recover the target node.
 */
export function htmlTextNodesToUnits(nodes: readonly HtmlTextNode[]): TranslationUnit[] {
  return nodes.map((node, order) => ({
    unitId: `html:${node.sid}:${node.index}`,
    order,
    kind: kindOf(node.tag),
    sourceText: node.text,
    metadata: {
      sid: node.sid,
      index: node.index,
      tag: node.tag,
      blockSid: node.blockSid,
      blockTag: node.blockTag,
      lead: node.lead,
      trail: node.trail,
    },
  }))
}

/** Recover the target text node from a unit id produced by {@link htmlTextNodesToUnits}. */
export function parseHtmlUnitId(unitId: string): { sid: number; index: number } | null {
  const match = /^html:(\d+):(\d+)$/.exec(unitId)
  if (!match) return null
  const sid = Number(match[1])
  const index = Number(match[2])
  if (!Number.isInteger(sid) || !Number.isInteger(index)) return null
  return { sid, index }
}

interface UnitTarget {
  sid: number
  index: number
  tag: string
  blockSid: number
  blockTag: string
  lead: string
  trail: string
}

function targetOf(unit: TranslatedUnit): UnitTarget {
  const metadata = (unit.metadata ?? {}) as Record<string, unknown>
  const sid = Number(metadata.sid)
  const index = Number(metadata.index)
  if (Number.isInteger(sid) && Number.isInteger(index)) {
    const blockSid = Number(metadata.blockSid)
    const blockTag = typeof metadata.blockTag === 'string' ? metadata.blockTag : ''
    return {
      sid,
      index,
      tag: typeof metadata.tag === 'string' ? metadata.tag : '',
      blockSid: Number.isInteger(blockSid) ? blockSid : sid,
      blockTag: blockTag || (typeof metadata.tag === 'string' ? metadata.tag : ''),
      lead: typeof metadata.lead === 'string' ? metadata.lead : '',
      trail: typeof metadata.trail === 'string' ? metadata.trail : '',
    }
  }
  const parsed = parseHtmlUnitId(unit.unitId)
  if (parsed) {
    return { ...parsed, tag: '', blockSid: parsed.sid, blockTag: '', lead: '', trail: '' }
  }
  throw new Error(`翻译单元 ${unit.unitId} 缺少文本节点坐标，拒绝回写以免写错位置`)
}

/**
 * Build the write-back ops for a settled run.
 *
 * `replace` rewrites each text node in place through `set_text_node`, which
 * keeps the element, its attributes and its sibling markup; `bilingual` leaves
 * the source untouched and inserts one translated sibling block after each
 * source block, reusing the block's own tag so the insertion is valid wherever
 * that block already lives. Exported (and pure) so both rules are testable
 * without running the pipeline.
 */
export function buildHtmlApplyOps(
  units: readonly TranslatedUnit[],
  mode: TranslateApplyMode,
): HtmlOp[] {
  const settled = units.filter(
    (unit) => typeof unit.translatedText === 'string' && unit.translatedText.trim() !== '',
  )
  if (mode === 'bilingual') {
    // One insertion per *block*, so a paragraph with inline markup (whose text
    // arrives as several units) gets one translated sentence, not a fragment
    // per inline run.
    const byBlock = new Map<number, { tag: string; parts: string[] }>()
    const order: number[] = []
    for (const unit of settled) {
      const target = targetOf(unit)
      const existing = byBlock.get(target.blockSid)
      if (existing) existing.parts.push(unit.translatedText.trim())
      else {
        byBlock.set(target.blockSid, { tag: target.blockTag, parts: [unit.translatedText.trim()] })
        order.push(target.blockSid)
      }
    }
    return order.map((blockSid) => {
      const { tag, parts } = byBlock.get(blockSid)!
      const insertTag =
        tag !== '' && BLOCK_TAGS.has(tag) && !STRUCTURAL_TAGS.has(tag) ? tag : INSERT_TAG_FALLBACK
      const content = parts.join(' ').replace(/\n+/g, '<br>')
      return {
        op: 'insert_html' as const,
        sid: blockSid,
        position: 'after' as const,
        html: `<${insertTag}>${escapeText(content)}</${insertTag}>`,
      }
    })
  }
  return settled.map((unit) => {
    const target = targetOf(unit)
    return {
      op: 'set_text_node' as const,
      sid: target.sid,
      index: target.index,
      // The separator whitespace is document content: `<p>Hello <b>world</b></p>`
      // must not collapse to `你好世界` just because the provider returned the
      // trimmed string it was asked to translate.
      text: `${target.lead}${unit.translatedText}${target.trail}`,
    }
  })
}

export type HtmlApplyResult =
  | { ok: true; ranges: Array<[number, number]> }
  | { ok: false; errors: OpError[] }

export interface HtmlApplyDeps {
  /**
   * The app's own op dispatcher: `compileOps` + `applyPatches` + commit, and
   * (when the editor is live) the CodeMirror patch applier. Injected so the
   * write-back cannot drift from what the manual / AI editing paths do.
   */
  applyOps: (
    ops: HtmlOp[],
    manual: boolean,
  ) => { ok: true; ranges: Array<[number, number]> } | { ok: false; errors: OpError[] }
}

/**
 * Write settled translations into the document.
 *
 * Goes through the app's op dispatcher — the same path behind the `apply_ops`
 * tool and the manual editing UI — so the result is a normal, undoable edit.
 * Compile errors are returned unchanged (a stale extraction that no longer
 * addresses the live source) rather than applying a partial batch.
 */
export function applyHtmlTranslations(
  deps: HtmlApplyDeps,
  units: readonly TranslatedUnit[],
  mode: TranslateApplyMode,
): HtmlApplyResult {
  const ops = buildHtmlApplyOps(units, mode)
  if (ops.length === 0) return { ok: true, ranges: [] }
  return deps.applyOps(ops, false)
}

export interface HtmlTranslateOptions {
  targetLang: string
  sourceLang?: string | undefined
  /** Defaults to `replace`. */
  applyMode?: TranslateApplyMode | undefined
  /** `selection` translates only the text node the current selection covers. */
  scope?: 'document' | 'selection' | undefined
  /** The selected text node, required for a selection run. */
  selection?: HtmlExtractWindow | undefined
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

export interface HtmlTranslateDeps {
  /** The live base text (the renderer's `textRef.current`). */
  text: string
  map: ParseMap
  /** Injected transport — the renderer reaches the provider through the bridge. */
  translateBatch: TranslateBatchFn
  /** Write-back seam; see {@link applyHtmlTranslations}. */
  applyOps: HtmlApplyDeps['applyOps']
  onProgress?: ((progress: TranslateProgress) => void | Promise<void>) | undefined
}

/**
 * Translate the whole document (or the selection) through the shared pipeline.
 *
 * Returns the pipeline's result verbatim so the caller can report
 * `completed` / `completed-with-failures` / `failed` / `cancelled` without
 * re-deriving them. A cancelled run writes nothing.
 */
export async function translateHtmlDocument(
  deps: HtmlTranslateDeps,
  options: HtmlTranslateOptions,
): Promise<TranslateDocumentResult> {
  const window = options.scope === 'selection' ? options.selection : undefined
  if (options.scope === 'selection' && !window) {
    throw new Error('选区翻译缺少选中的文本节点')
  }
  const nodes = extractHtmlTextNodes(deps.text, deps.map, window)
  const units = htmlTextNodesToUnits(nodes)
  const mode: TranslateApplyMode = options.applyMode ?? 'replace'

  return translateDocument(
    {
      units,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      preserveFormat: options.preserveFormat,
      scene: options.scene ?? 'html-document',
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
      apply: ({ units: settled, mode: appliedMode }) => {
        const result = applyHtmlTranslations({ applyOps: deps.applyOps }, settled, appliedMode)
        if (!result.ok) {
          throw new Error(
            `译文回写失败：${result.errors.map((e) => e.message).join('; ') || '未知错误'}`,
          )
        }
      },
    },
  )
}
