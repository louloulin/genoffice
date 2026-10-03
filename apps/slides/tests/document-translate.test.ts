import { describe, expect, it } from 'vitest'
import {
  composeFrameText,
  deckFramesToUnits,
  extractDeckTextFrames,
  frameText,
  isTranslatableFrameText,
  parseDeckUnitId,
  translateDeckDocument,
  type DeckTranslateWrite,
  type SlideLike,
} from '../src/renderer/ai/document-translate'
import type { TranslateBatchRequest, TranslateBatchResponse } from '@genoffice/translation-core/document'

const upper = async (request: TranslateBatchRequest): Promise<TranslateBatchResponse> => ({
  ok: true,
  units: request.units.map((unit) => ({
    unitId: unit.unitId,
    sourceText: unit.sourceText,
    translatedText: unit.sourceText.toUpperCase(),
    status: 'translated' as const,
  })),
})

const line = (text: string, paraStart = true) => ({ runs: [{ text }], paraStart })

describe('frameText', () => {
  it('joins runs inside one line', () => {
    expect(frameText([{ runs: [{ text: 'Hello ' }, { text: 'world' }], paraStart: true }])).toBe('Hello world')
  })

  it('starts a new paragraph only on paraStart', () => {
    const lines = [
      { runs: [{ text: 'First para' }], paraStart: true, trailingSpace: true },
      { runs: [{ text: 'wrapped' }], paraStart: false },
      { runs: [{ text: 'Second para' }], paraStart: true },
    ]
    expect(frameText(lines)).toBe('First para wrapped\nSecond para')
  })

  it('skips the bullet glyph the layout engine injected for a buChar paragraph', () => {
    // The layout engine prepends a *non-body* run carrying the bullet glyph
    // (GlyphRun.isBullet). It is not model text: feeding "• Purchase order" to
    // the model and writing the result back would put a literal "•" into the
    // model text while the paragraph still carries <a:buChar> — a doubled bullet
    // on every bulleted line. Caught end-to-end on a real deck in the drive
    // translation e2e; the write-back goes through slides:edit-text, which
    // round-trips the paragraph's own bullet properties.
    const bulleted = [
      {
        runs: [{ text: '\u2022', isBullet: true }, { text: 'Purchase Order delays' }],
        paraStart: true,
      },
    ]
    expect(frameText(bulleted)).toBe('Purchase Order delays')
  })

  it('keeps a literal bullet that is real model text', () => {
    // A deck whose author typed "•" as ordinary text has no isBullet flag, so
    // the filter must not be a plain character strip.
    const typed = [{ runs: [{ text: '\u2022 Manual step' }], paraStart: true }]
    expect(frameText(typed)).toBe('\u2022 Manual step')
  })

  it('keeps an empty bulleted paragraph as an empty line, not a stray glyph', () => {
    // An empty bulleted paragraph lays out as a line carrying only the glyph;
    // dropping the glyph but keeping the line round-trips the blank paragraph.
    const lines = [
      { runs: [{ text: 'Item one' }], paraStart: true },
      { runs: [{ text: '\u25aa', isBullet: true }], paraStart: true },
      { runs: [{ text: 'Item two' }], paraStart: true },
    ]
    expect(frameText(lines)).toBe('Item one\n\nItem two')
  })

  it('re-inserts the exact whitespace the layout engine swallowed at the wrap', () => {
    // CJK wraps without a space and the engine records *which* whitespace it
    // dropped (`trailingText`). Joining with a hard space would corrupt it;
    // joining with '' would glue Latin words together.
    const cjk = [
      { runs: [{ text: '中文' }], paraStart: true, trailingSpace: true, trailingText: '' },
      { runs: [{ text: '换行' }], paraStart: false },
    ]
    expect(frameText(cjk)).toBe('中文换行')
    const latin = [
      { runs: [{ text: 'Hello' }], paraStart: true, trailingSpace: true, trailingText: '  ' },
      { runs: [{ text: 'world' }], paraStart: false },
    ]
    expect(frameText(latin)).toBe('Hello  world')
  })

  it('defaults the swallowed whitespace to a single space on stored decks', () => {
    // Stored decks predate `trailingText`; the render-tree contract says the
    // value is then a single space.
    const lines = [
      { runs: [{ text: 'Hello' }], paraStart: true, trailingSpace: true },
      { runs: [{ text: 'world' }], paraStart: false },
    ]
    expect(frameText(lines)).toBe('Hello world')
  })

  it('adds nothing when the layout recorded no swallowed whitespace', () => {
    // Trust the layout data: a line with no `trailingSpace` had no space at the
    // wrap point, and inventing one would corrupt CJK text.
    const lines = [
      { runs: [{ text: '中文' }], paraStart: true },
      { runs: [{ text: '换行' }], paraStart: false },
    ]
    expect(frameText(lines)).toBe('中文换行')
  })

  it('returns empty for a frame with no lines', () => {
    expect(frameText(undefined)).toBe('')
    expect(frameText([])).toBe('')
  })
})

describe('isTranslatableFrameText', () => {
  it('rejects blank and over-long frames', () => {
    expect(isTranslatableFrameText('  \n ')).toBe(false)
    expect(isTranslatableFrameText('x'.repeat(8_001))).toBe(false)
    expect(isTranslatableFrameText('ok')).toBe(true)
  })
})

describe('extractDeckTextFrames', () => {
  const slide: SlideLike = {
    nodes: [
      { id: 'n1', type: 'shape', sourceId: 's1', text: { lines: [line('Title')] } },
      // master/layout decoration: read-only, writing to it fails or is dropped
      { id: 'n2', type: 'shape', sourceId: 's2', decoration: true, text: { lines: [line('Footer')] } },
      {
        id: 'g1',
        type: 'group',
        children: [{ id: 'n3', type: 'text', sourceId: 's3', text: { lines: [line('Inside group')] } }],
      },
      { id: 'n4', type: 'shape', sourceId: 's4', text: { lines: [line('   ')] } },
      { id: 'n5', type: 'table', sourceId: 's5' },
    ],
  }

  it('collects translatable frames and skips decoration / blanks / tables', () => {
    const frames = extractDeckTextFrames([slide])
    expect(frames.map((frame) => frame.sourceId)).toEqual(['s1', 's3'])
  })

  it('records the enclosing group path so the edit op can address it', () => {
    const frames = extractDeckTextFrames([slide])
    expect(frames[1]?.groupPath).toEqual(['g1'])
    expect(frames[0]?.groupPath).toEqual([])
  })

  it('numbers units in slide then z-order', () => {
    const frames = extractDeckTextFrames([slide, { nodes: [{ id: 'x', type: 'text', sourceId: 's9', text: { lines: [line('Slide two')] } }] }])
    expect(frames.map((frame) => [frame.slideIndex, frame.order])).toEqual([
      [0, 0],
      [0, 1],
      [1, 2],
    ])
  })

  it('mints a unique unit id per slide', () => {
    const same = { nodes: [{ id: 'a', type: 'text', sourceId: 'same', text: { lines: [line('X')] } }] }
    const frames = extractDeckTextFrames([same, same])
    expect(frames[0]?.unitId).not.toBe(frames[1]?.unitId)
  })

  it('throws rather than silently truncating a huge deck', () => {
    const nodes = Array.from({ length: 5_001 }, (_unused, index) => ({
      id: `n${index}`,
      type: 'text',
      sourceId: `s${index}`,
      text: { lines: [line(`t${index}`)] },
    }))
    expect(() => extractDeckTextFrames([{ nodes }])).toThrow(/超过/)
  })
})

describe('deckFramesToUnits', () => {
  it('carries the write-back coordinates as metadata', () => {
    const frames = extractDeckTextFrames([
      { nodes: [{ id: 'g', type: 'group', children: [{ id: 'n', type: 'text', sourceId: 's', text: { lines: [line('Body')] } }] }] },
    ])
    const unit = deckFramesToUnits(frames)[0]!
    expect(unit.metadata).toEqual({ slideIndex: 0, sourceId: 's', groupPath: ['g'] })
  })
})

describe('composeFrameText', () => {
  it('replaces in replace mode', () => {
    expect(composeFrameText('Hello', '你好', 'replace')).toBe('你好')
  })

  it('keeps the source above the translation in bilingual mode', () => {
    expect(composeFrameText('Hello', '你好', 'bilingual')).toBe('Hello\n你好')
  })
})

describe('translateDeckDocument', () => {
  const slide: SlideLike = {
    nodes: [
      { id: 'n1', type: 'shape', sourceId: 's1', text: { lines: [line('Title')] } },
      { id: 'n2', type: 'shape', sourceId: 's2', text: { lines: [line('Body')] } },
    ],
  }

  it('writes each frame back through the injected edit op', async () => {
    const writes: DeckTranslateWrite[] = []
    const result = await translateDeckDocument(
      {
        slides: [slide],
        translateBatch: upper,
        writeFrame: async (write) => { writes.push(write) },
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('completed')
    expect(writes.map((write) => [write.sourceId, write.text])).toEqual([
      ['s1', 'TITLE'],
      ['s2', 'BODY'],
    ])
  })

  it('bilingual mode keeps the source in the frame', async () => {
    const writes: DeckTranslateWrite[] = []
    await translateDeckDocument(
      {
        slides: [slide],
        translateBatch: upper,
        writeFrame: async (write) => { writes.push(write) },
      },
      { targetLang: 'zh-CN', applyMode: 'bilingual' },
    )
    expect(writes[0]?.text).toBe('Title\nTITLE')
  })

  it('reports a failed write instead of reporting a completed deck', async () => {
    const result = await translateDeckDocument(
      {
        slides: [slide],
        translateBatch: upper,
        writeFrame: async () => { throw new Error('edit-text rejected the frame') },
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('failed')
    expect(result.error).toContain('edit-text rejected')
  })

  it('a cancelled run writes nothing', async () => {
    const writes: DeckTranslateWrite[] = []
    const controller = new AbortController()
    controller.abort()
    const result = await translateDeckDocument(
      {
        slides: [slide],
        translateBatch: upper,
        writeFrame: async (write) => { writes.push(write) },
      },
      { targetLang: 'zh-CN', signal: controller.signal },
    )
    expect(result.status).toBe('cancelled')
    expect(writes).toEqual([])
  })

  it('an empty deck completes without calling the provider', async () => {
    let called = false
    const result = await translateDeckDocument(
      {
        slides: [{ nodes: [] }],
        translateBatch: async (request) => {
          called = true
          return { ok: true, units: request.units.map((unit) => ({ unitId: unit.unitId, sourceText: unit.sourceText, translatedText: '', status: 'translated' as const })) }
        },
        writeFrame: async () => {},
      },
      { targetLang: 'zh-CN' },
    )
    expect(result.status).toBe('completed')
    expect(called).toBe(false)
  })
})

describe('parseDeckUnitId', () => {
  it('round-trips a top-level frame', () => {
    const frames = extractDeckTextFrames([
      { nodes: [{ id: 'el-1', type: 'shape', text: { lines: [{ runs: [{ text: 'Hello' }], paraStart: true }] } }] },
    ])
    expect(parseDeckUnitId(frames[0]!.unitId)).toEqual({ slideIndex: 0, sourceId: 'el-1', groupPath: [] })
  })

  it('round-trips a grouped frame', () => {
    const frames = extractDeckTextFrames([
      {
        nodes: [
          {
            id: 'g1',
            type: 'group',
            children: [
              { id: 'g2', type: 'group', children: [{ id: 'el-9', type: 'shape', text: { lines: [{ runs: [{ text: 'Deep' }], paraStart: true }] } }] },
            ],
          },
        ],
      },
    ])
    expect(parseDeckUnitId(frames[0]!.unitId)).toEqual({
      slideIndex: 0,
      sourceId: 'el-9',
      groupPath: ['g1', 'g2'],
    })
  })

  it('keeps a `#` inside the source id (the minted form percent-encodes it)', () => {
    // The extractor encodes each component, so the separator stays unambiguous
    // even for a durable id that contains `#`.
    const frames = extractDeckTextFrames([
      { nodes: [{ id: 'el#7', type: 'shape', text: { lines: [{ runs: [{ text: 'Hash' }], paraStart: true }] } }] },
    ])
    expect(parseDeckUnitId(frames[0]!.unitId)).toEqual({ slideIndex: 0, sourceId: 'el#7', groupPath: [] })
  })

  it('rejects a malformed percent-escape rather than decoding a guess', () => {
    expect(parseDeckUnitId('slide3##%E0%A4%A')).toBeNull()
  })

  it('rejects ids that are not ours instead of guessing a target', () => {
    // Guessing here is how a translation ends up in someone else's text frame.
    expect(parseDeckUnitId('selection-1')).toBeNull()
    expect(parseDeckUnitId('slideX#a#b')).toBeNull()
    expect(parseDeckUnitId('slide1#only-one-separator')).toBeNull()
    expect(parseDeckUnitId('slide-2##el-1')).toBeNull()
    expect(parseDeckUnitId('slide2##')).toBeNull()
  })
})
