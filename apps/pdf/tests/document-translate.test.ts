import { describe, expect, it } from 'vitest'
import {
  applyPdfTranslations,
  buildPdfBilingualInput,
  buildPdfReplaceInput,
  extractPdfTextBlocks,
  isTranslatableBlockText,
  MAX_TRANSLATE_BLOCKS,
  parsePdfUnitId,
  pdfBilingualOrigin,
  pdfBlocksToUnits,
  translatePdfDocument,
  type PdfTextBlock,
} from '../src/renderer/ai/document-translate'
import type { PageEntry } from '../src/renderer/search'
import type { TextBlock } from '../src/renderer/text-block'
import type {
  TranslateBatchRequest,
  TranslateBatchResponse,
} from '@genoffice/translation-core/document'

/** Build a PageEntry from positioned lines (y-up, PDF user space). */
function entryOf(rows: Array<{ y: number; h?: number; x?: number; w?: number; text: string }>): PageEntry {
  let text = ''
  const items = rows.map((r) => {
    const start = text.length
    text += r.text
    return {
      start,
      end: text.length,
      x: r.x ?? 50,
      y: r.y,
      w: r.w ?? Math.max(r.text.length * 5, 1),
      h: r.h ?? 10,
    }
  })
  return { text, lower: text.toLowerCase(), items }
}

/** Transport that upper-cases every unit so a write is an obvious change. */
const upperTransport = async (request: TranslateBatchRequest): Promise<TranslateBatchResponse> => ({
  ok: true,
  units: request.units.map((unit) => ({
    unitId: unit.unitId,
    sourceText: unit.sourceText,
    translatedText: unit.sourceText.toUpperCase(),
    status: 'translated' as const,
  })),
})

const failingTransport = async (): Promise<TranslateBatchResponse> => {
  throw new Error('provider down')
}

/** A block built directly, for the geometry-only assertions. */
function block(over: Partial<TextBlock> = {}): TextBlock {
  return {
    rect: [50, 700, 300, 730],
    fontSize: 12,
    lineHeight: 14.4,
    align: 'left',
    lines: [
      { rect: [50, 712, 300, 730], text: 'Hello world', y: 712, fontSize: 12 },
      { rect: [50, 698, 300, 716], text: 'second line', y: 698, fontSize: 12 },
    ],
    ...over,
  }
}

describe('isTranslatableBlockText', () => {
  it('accepts prose', () => {
    expect(isTranslatableBlockText('Hello world')).toBe(true)
  })
  it('accepts CJK', () => {
    expect(isTranslatableBlockText('你好世界')).toBe(true)
  })
  it('rejects single characters (page numbers, bullet glyphs)', () => {
    expect(isTranslatableBlockText('7')).toBe(false)
  })
  it('rejects blank and whitespace-only', () => {
    expect(isTranslatableBlockText('   \n  ')).toBe(false)
  })
  it('rejects pure numbers, dates and totals', () => {
    // These come back unchanged at best and mangled at worst.
    expect(isTranslatableBlockText('2026-10-04')).toBe(false)
    expect(isTranslatableBlockText('1,234.56')).toBe(false)
    expect(isTranslatableBlockText('+86 10 1234')).toBe(false)
  })
})

describe('extractPdfTextBlocks', () => {
  it('clusters a page into blocks and pins them to the page index', () => {
    const index = [
      entryOf([
        { y: 712, text: 'First paragraph line one' },
        { y: 698, text: 'and its second line' },
      ]),
      entryOf([{ y: 700, text: 'Page two heading' }]),
    ]
    const blocks = extractPdfTextBlocks(index)
    expect(blocks.length).toBe(2)
    expect(blocks[0]!.pageIndex).toBe(0)
    expect(blocks[1]!.pageIndex).toBe(1)
  })

  it('drops blocks that are not worth translating', () => {
    const index = [entryOf([{ y: 700, text: '2026' }])]
    expect(extractPdfTextBlocks(index)).toEqual([])
  })

  it('caps runaway documents instead of billing for them', () => {
    // Every block is its own paragraph: no vertical neighbours to merge with.
    const rows = Array.from({ length: MAX_TRANSLATE_BLOCKS + 50 }, (_, i) => ({
      y: 900 - i * 30,
      text: `paragraph number ${i} with some words`,
    }))
    const blocks = extractPdfTextBlocks([entryOf(rows)])
    expect(blocks.length).toBeGreaterThan(MAX_TRANSLATE_BLOCKS)
    expect(blocks.length).toBeLessThanOrEqual(MAX_TRANSLATE_BLOCKS + 1)
  })
})

describe('pdfBlocksToUnits / parsePdfUnitId', () => {
  it('mints ids that round-trip back to their page and block', () => {
    const blocks: PdfTextBlock[] = [
      { pageIndex: 0, block: block() },
      { pageIndex: 2, block: block() },
      { pageIndex: 2, block: block() },
    ]
    const units = pdfBlocksToUnits(blocks)
    expect(units.map((u) => u.unitId)).toEqual(['p0-b0', 'p2-b0', 'p2-b1'])
    expect(parsePdfUnitId('p2-b1')).toEqual({ pageIndex: 2, blockIndex: 1 })
    expect(parsePdfUnitId('nonsense')).toBeNull()
  })

  it('carries the block text as the source', () => {
    const units = pdfBlocksToUnits([{ pageIndex: 0, block: block() }])
    expect(units[0]!.sourceText).toContain('Hello world')
  })
})

describe('buildPdfReplaceInput', () => {
  it('anchors the rebuild to the block, not the matched run', () => {
    const input = buildPdfReplaceInput(3, block(), '你好世界')
    expect(input.pageIndex).toBe(3)
    expect(input.newText).toBe('你好世界')
    // The matched anchor can be indented or mid-paragraph; the rebuild is
    // pinned to the block's own left edge / first baseline.
    expect(input.origin).toEqual([50, 712])
    expect(input.fontSize).toBe(12)
    expect(input.lineLeading).toBe(14.4)
  })

  it('omits `translate` — that field means "move as-is", not "replace"', () => {
    // Present, the engine would treat the run as a pure move and require
    // newText to be textually equivalent to oldText — i.e. skip the
    // translation entirely, silently.
    const input = buildPdfReplaceInput(0, block(), '你好世界')
    expect('translate' in input).toBe(false)
  })

  it('only carries align when it is not the default', () => {
    expect('align' in buildPdfReplaceInput(0, block({ align: 'left' }), 'x')).toBe(false)
    expect(buildPdfReplaceInput(0, block({ align: 'center' }), 'x').align).toBe('center')
  })
})

describe('pdfBilingualOrigin', () => {
  it('places the translation below the block (y-up means smaller y)', () => {
    const [x, y] = pdfBilingualOrigin(block(), 0)
    expect(x).toBe(50)
    expect(y).toBeLessThan(block().rect[1])
  })

  it('flips above when the block sits too close to the page bottom', () => {
    // A translation rendered outside the MediaBox is invisible, which the user
    // cannot tell apart from "nothing was translated".
    const low = block({ rect: [50, 6, 300, 36], lines: [{ rect: [50, 6, 300, 36], text: 'x', y: 6, fontSize: 12 }] })
    const [, y] = pdfBilingualOrigin(low, 0)
    expect(y).toBeGreaterThan(low.rect[3])
  })

  it('honours a non-zero MediaBox bottom instead of assuming y=0', () => {
    // Cropped pages have view[1] > 0; comparing against 0 would let the
    // translation land in the cropped-away strip.
    const b = block({ rect: [50, 106, 300, 136], lines: [{ rect: [50, 106, 300, 136], text: 'x', y: 106, fontSize: 12 }] })
    const [, y] = pdfBilingualOrigin(b, 100)
    expect(y).toBeGreaterThan(b.rect[3])
    // Same block, no geometry available: stays below rather than flipping.
    expect(pdfBilingualOrigin(b, undefined)[1]).toBeLessThan(b.rect[1])
  })
})

describe('buildPdfBilingualInput', () => {
  it('produces a stacked insert, leaving the original text object alone', () => {
    const input = buildPdfBilingualInput(1, block(), '你好世界', 0)
    expect(input.pageIndex).toBe(1)
    expect(input.text).toBe('你好世界')
    expect(input.fontSize).toBe(12)
    expect(input.lineLeading).toBe(14.4)
  })
})

describe('applyPdfTranslations', () => {
  const blocks: PdfTextBlock[] = [
    { pageIndex: 0, block: block() },
    { pageIndex: 1, block: block() },
  ]

  it('replace mode yields one rebuild edit and no inserts', () => {
    const units = pdfBlocksToUnits(blocks).map((u) => ({
      ...u,
      order: 0,
      translatedText: 'T',
      status: 'translated' as const,
    })) as never
    const plan = applyPdfTranslations(blocks, units, 'replace')
    expect(plan.edits).toHaveLength(2)
    expect(plan.inserts).toHaveLength(0)
    expect(plan.edits.map((e) => e.pageIndex)).toEqual([0, 1])
  })

  it('bilingual mode yields inserts and no rebuild edits', () => {
    const units = pdfBlocksToUnits(blocks).map((u) => ({
      ...u,
      order: 0,
      translatedText: 'T',
      status: 'translated' as const,
    })) as never
    const plan = applyPdfTranslations(blocks, units, 'bilingual', [0, 0])
    expect(plan.edits).toHaveLength(0)
    expect(plan.inserts).toHaveLength(2)
  })

  it('skips units with empty or missing translations', () => {
    const units = [
      { unitId: 'p0-b0', order: 0, kind: 'paragraph' as const, sourceText: 'a', translatedText: '   ', status: 'translated' as const },
      { unitId: 'p1-b0', order: 1, kind: 'paragraph' as const, sourceText: 'b', status: 'translated' as const },
    ] as never
    const plan = applyPdfTranslations(blocks, units, 'replace')
    expect(plan.edits).toHaveLength(0)
  })

  it('skips units whose id matches no extracted block', () => {
    const plan = applyPdfTranslations(
      [],
      [{ unitId: 'p9-b9', order: 0, kind: 'paragraph' as const, sourceText: 'a', translatedText: 'T', status: 'translated' as const }] as never,
      'replace',
    )
    expect(plan.edits).toHaveLength(0)
  })
})

describe('translatePdfDocument', () => {
  const index = [entryOf([{ y: 700, text: 'Translatable body text' }])]

  it('hands the caller a real write plan (regression: an empty-units apply dropped every translation)', async () => {
    let plan: { edits: unknown[]; inserts: unknown[] } | null = null
    const result = await translatePdfDocument(
      {
        searchIndex: index,
        translateBatch: upperTransport,
        onPlan: (p) => {
          plan = p
        },
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('completed')
    expect(result.applied).toBe(true)
    // The plan must be built from the SETTLED units, not an empty list: this
    // run would otherwise report `completed` with nothing written.
    expect(plan!.edits).toHaveLength(1)
    expect((plan!.edits[0] as { newText: string }).newText).toBe('TRANSLATABLE BODY TEXT')
  })

  it('hands the caller the exact extraction it used', async () => {
    // Review-then-apply re-derives geometry from these blocks. Re-extracting at
    // Apply time could re-cluster a document the user edited while reviewing,
    // writing the translation onto a paragraph the run never saw.
    let seen: unknown = null
    await translatePdfDocument(
      {
        searchIndex: index,
        translateBatch: upperTransport,
        onBlocks: (b) => {
          seen = b
        },
      },
      { targetLang: 'zh-CN' },
    )
    expect(seen).toHaveLength(1)
    expect((seen as Array<{ pageIndex: number }>)[0]!.pageIndex).toBe(0)
  })

  it('produces inserts in bilingual mode', async () => {
    let plan: { edits: unknown[]; inserts: unknown[] } | null = null
    await translatePdfDocument(
      { searchIndex: index, translateBatch: upperTransport, onPlan: (p) => { plan = p } },
      { targetLang: 'zh-CN', applyMode: 'bilingual' },
    )
    expect(plan!.inserts).toHaveLength(1)
    expect(plan!.edits).toHaveLength(0)
  })

  it('reports provider failure instead of reporting an empty success', async () => {
    const result = await translatePdfDocument(
      { searchIndex: index, translateBatch: failingTransport },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('provider down')
  })

  it('writes nothing when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    let called = false
    const result = await translatePdfDocument(
      {
        searchIndex: index,
        translateBatch: async (req, signal) => {
          if (signal?.aborted) throw new Error('aborted')
          return upperTransport(req)
        },
        onPlan: () => {
          called = true
        },
      },
      { targetLang: 'zh-CN', signal: controller.signal },
    )
    expect(result.status).toBe('cancelled')
    expect(called).toBe(false)
  })
})
