/**
 * Markdown whole-document / selection / bilingual translation (A51/A52).
 *
 * The adapter is two halves — extract text blocks out of the ProseMirror tree,
 * and write settled translations back through the same `MdOp` layer the AI's
 * `apply_ops` tool uses. These tests pin both halves plus the wiring into
 * `translateDocument`, because the failure mode they guard against is silent:
 * a write-back that targets the wrong block still produces a *translated*
 * document, just not the one the user asked for.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import type { TranslateBatchFn } from '@genoffice/translation-core/document'
import { buildExtensions } from '../src/renderer/editor/extensions'
import {
  applyMarkdownTranslations,
  buildMarkdownApplyOps,
  extractMarkdownTextBlocks,
  markdownBlocksToUnits,
  parseMarkdownUnitId,
  translateMarkdownDocument,
} from '../src/renderer/ai/document-translate'

const editors: Editor[] = []
afterEach(() => {
  for (const e of editors.splice(0)) e.destroy()
})

function createEditor(md = ''): Editor {
  const editor = new Editor({
    extensions: buildExtensions({
      slashController: { onOpen() {}, onUpdate() {}, onKeyDown: () => false, onClose() {} },
      slashItems: () => [],
    }),
    content: '',
  })
  if (md) editor.commands.setContent(md, { contentType: 'markdown' })
  editors.push(editor)
  return editor
}

/**
 * `kind:text` per top-level block — the shape a write-back bug shows up in.
 * ProseMirror appends an empty trailing paragraph after a list, which is the
 * editor's own node rather than anything a run produced, so it is dropped.
 */
function blocks(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.forEach((n) => out.push(`${n.type.name}:${n.textContent}`))
  if (out.length > 1 && out[out.length - 1] === 'paragraph:') out.pop()
  return out
}

/** Translation that is trivially distinguishable from its source. */
function echoing(map?: Record<string, string>): TranslateBatchFn {
  return async (request, _signal, onUnit) => {
    const units = request.units.map((unit) => ({
      unitId: unit.unitId,
      sourceText: unit.sourceText,
      translatedText: map?.[unit.sourceText] ?? `[${unit.sourceText}]`,
      status: 'translated' as const,
    }))
    for (const unit of units) await onUnit?.(unit)
    return { ok: true, units }
  }
}

describe('extractMarkdownTextBlocks (A51)', () => {
  it('takes headings, paragraphs, list items and table cells — and nothing else', () => {
    const editor = createEditor(
      [
        '# Title',
        '',
        'First paragraph.',
        '',
        '- item one',
        '- item two',
        '',
        '| head | cell |',
        '| --- | --- |',
        '| a | b |',
        '',
        '```',
        'const a = 1',
        '```',
      ].join('\n'),
    )

    const extracted = extractMarkdownTextBlocks(editor.state.doc)
    expect(extracted.map((b) => `${b.kind}:${b.text}`)).toEqual([
      'heading:Title',
      'paragraph:First paragraph.',
      'list-item:item one',
      'list-item:item two',
      'table-cell:head',
      'table-cell:cell',
      'table-cell:a',
      'table-cell:b',
    ])
    // A translated code block is a broken program; frontmatter is metadata.
    expect(extracted.some((b) => b.text.includes('const a = 1'))).toBe(false)
    // Every unit keeps the *top-level* block it lives in, so the write-back
    // addresses the same coordinate the op layer does.
    expect(extracted[2]!.blockIndex).toBe(2)
    expect(extracted[3]!.blockIndex).toBe(2)
    expect(extracted[4]!.blockIndex).toBe(3)
  })

  it('addresses unit ids round-trippably', () => {
    const units = markdownBlocksToUnits([
      { blockIndex: 4, kind: 'paragraph', text: 'hello' },
      { blockIndex: 7, kind: 'heading', text: 'title' },
    ])
    expect(units.map((u) => u.unitId)).toEqual(['md:4:0', 'md:7:1'])
    expect(units.map((u) => u.kind)).toEqual(['paragraph', 'heading'])
    expect(parseMarkdownUnitId('md:4:0')).toEqual({ blockIndex: 4 })
    expect(parseMarkdownUnitId('md:7:1')).toEqual({ blockIndex: 7 })
    expect(parseMarkdownUnitId('docx:p12')).toBeNull()
    expect(parseMarkdownUnitId('md:x:0')).toBeNull()
  })
})

describe('buildMarkdownApplyOps (A51)', () => {
  const settled = (unitId: string, sourceText: string, translatedText: string) => ({
    unitId,
    order: 0,
    kind: 'paragraph' as const,
    sourceText,
    translatedText,
    status: 'translated' as const,
    metadata: { blockIndex: Number(/^md:(\d+):/.exec(unitId)?.[1] ?? 0) },
  })

  it('replace rewrites each block in place through replaceText', () => {
    const ops = buildMarkdownApplyOps(
      [settled('md:1:0', 'Hello world.', '你好世界。'), settled('md:3:1', 'Bye.', '再见。')],
      'replace',
    )
    expect(ops).toEqual([
      {
        op: 'replaceText',
        target: { start: 1, end: 1 },
        find: 'Hello world.',
        replace: '你好世界。',
      },
      { op: 'replaceText', target: { start: 3, end: 3 }, find: 'Bye.', replace: '再见。' },
    ])
  })

  it('bilingual keeps the source and inserts one translated paragraph per block', () => {
    const ops = buildMarkdownApplyOps(
      [
        settled('md:2:0', 'first', '第一'),
        settled('md:2:1', 'second', '第二'),
        settled('md:5:2', 'other', '其它'),
      ],
      'bilingual',
    )
    expect(ops).toEqual([
      { op: 'insertContent', after: 2, markdown: '第一\n\n第二' },
      { op: 'insertContent', after: 5, markdown: '其它' },
    ])
  })

  it('refuses a unit whose block coordinate cannot be recovered', () => {
    expect(() =>
      buildMarkdownApplyOps(
        [{ ...settled('weird', 'x', 'y'), unitId: 'weird', metadata: undefined }],
        'replace',
      ),
    ).toThrow(/缺少块坐标/)
  })
})

describe('translateMarkdownDocument (A52)', () => {
  it('translates the whole document in place and keeps the block structure', async () => {
    const editor = createEditor('# Title\n\nHello world.\n\n- one\n- two')
    const result = await translateMarkdownDocument(
      { editor, translateBatch: echoing() },
      { targetLang: 'zh-CN', qualityCheck: false },
    )

    expect(result.status).toBe('completed')
    expect(result.applied).toBe(true)
    expect(result.mode).toBe('replace')
    expect(blocks(editor)).toEqual([
      'heading:[Title]',
      'paragraph:[Hello world.]',
      'bulletList:[one][two]',
    ])
  })

  it('bilingual leaves the source untouched and appends the translation', async () => {
    const editor = createEditor('Hello world.')
    const result = await translateMarkdownDocument(
      { editor, translateBatch: echoing() },
      { targetLang: 'zh-CN', applyMode: 'bilingual', qualityCheck: false },
    )

    expect(result.mode).toBe('bilingual')
    expect(blocks(editor)).toEqual(['paragraph:Hello world.', 'paragraph:[Hello world.]'])
  })

  it('a selection run only touches the blocks the selection covers', async () => {
    const editor = createEditor('Alpha.\n\nBeta.\n\nGamma.')
    // Caret inside the second paragraph → block window [1, 1].
    let caret = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Beta.') caret = pos + 1
      return true
    })
    editor.commands.setTextSelection(caret)

    const result = await translateMarkdownDocument(
      { editor, translateBatch: echoing() },
      { targetLang: 'zh-CN', scope: 'selection', qualityCheck: false },
    )

    expect(result.status).toBe('completed')
    expect(blocks(editor)).toEqual(['paragraph:Alpha.', 'paragraph:[Beta.]', 'paragraph:Gamma.'])
  })

  it('a review-then-apply caller gets the settled units without a write', async () => {
    const editor = createEditor('Review me.')
    const result = await translateMarkdownDocument(
      { editor, translateBatch: echoing(), apply: () => {} },
      { targetLang: 'zh-CN', qualityCheck: false },
    )

    // Nothing written yet — `applied` only records that the pipeline ran the
    // caller's apply step (here a no-op), the same contract the docs dialog
    // relies on: writing is the review dialog's Apply button, not the run.
    expect(blocks(editor)).toEqual(['paragraph:Review me.'])
    expect(result.units.map((u) => u.translatedText)).toEqual(['[Review me.]'])
    applyMarkdownTranslations(editor, result.units, 'replace')
    expect(blocks(editor)).toEqual(['paragraph:[Review me.]'])
  })

  it('forwards the checkpoint adapter so a resumed run does not re-bill', async () => {
    const editor = createEditor('One.\n\nTwo.')
    const saved: string[] = []
    const result = await translateMarkdownDocument(
      {
        editor,
        translateBatch: echoing(),
        // No load hit: this pins that the caller's store is threaded through
        // and *written* once per settled unit.
      },
      {
        targetLang: 'zh-CN',
        qualityCheck: false,
        checkpoint: {
          load: () => null,
          save: (unitId) => void saved.push(unitId),
        },
      },
    )

    expect(result.status).toBe('completed')
    expect(saved).toHaveLength(2)
  })

  it('reports failures instead of writing half a document', async () => {
    const editor = createEditor('Good.\n\nBad.')
    const batch: TranslateBatchFn = async (request) => ({
      ok: false,
      units: request.units.map((unit) =>
        unit.sourceText === 'Bad.'
          ? {
              unitId: unit.unitId,
              sourceText: unit.sourceText,
              status: 'failed' as const,
              errorMessage: 'credit balance is too low',
              errorCode: 'credits' as const,
            }
          : {
              unitId: unit.unitId,
              sourceText: unit.sourceText,
              translatedText: `[${unit.sourceText}]`,
              status: 'translated' as const,
            },
      ),
    })

    const result = await translateMarkdownDocument(
      { editor, translateBatch: batch },
      { targetLang: 'zh-CN', qualityCheck: false },
    )

    expect(result.status).toBe('completed-with-failures')
    expect(result.failures.map((f) => f.errorCode)).toEqual(['credits'])
    // The successful block is written; the failed one is left in its source
    // language rather than being blanked.
    expect(blocks(editor)).toEqual(['paragraph:[Good.]', 'paragraph:Bad.'])
  })
})
