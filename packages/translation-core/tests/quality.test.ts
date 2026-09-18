import { describe, expect, it } from 'vitest'

import { assessBatchQuality, assessQuality } from '../src/quality'

describe('assessQuality', () => {
  it('flags empty output', () => {
    const r = assessQuality('hello world', '')
    expect(r.empty).toBe(true)
    expect(r.overallScore).toBe(0)
    expect(r.warnings).toContain('empty')
  })

  it('flags a refusal marker', () => {
    const r = assessQuality('translate me', 'I cannot translate that for you.')
    expect(r.warnings).toContain('refusal-marker')
  })

  it('flags an untranslated echo of a meaningful input', () => {
    const r = assessQuality(
      'Hello world, this is a longer test case.',
      'Hello world, this is a longer test case.',
    )
    expect(r.warnings).toContain('untranslated')
    expect(r.untranslated).toBe(true)
  })

  it('returns a clean report for plausible translations', () => {
    const r = assessQuality('Hello world', '你好世界')
    expect(r.warnings).toEqual([])
    expect(r.overallScore).toBe(1)
  })

  it('flags too-short / too-long relative to source length', () => {
    const r1 = assessQuality('a'.repeat(40), 'x')
    expect(r1.warnings).toContain('too-short')
    const r2 = assessQuality('hi', 'a'.repeat(40))
    expect(r2.warnings).toContain('too-long')
  })

  it('does not flag a dense CJK translation as too-short', () => {
    // Raw character counts made every short Chinese term look truncated:
    // "Fabric weight" -> "克重" measured 2/13. The Han characters carry the
    // same information, so the unit must pass.
    for (const [source, translated] of [
      ['Fabric weight', '克重'],
      ['Fabric weight spec', '克重规格'],
      ['Machine wash cold with like colors', '冷水同色洗涤'],
      ['WATER REPELLENT FINISH', '防水整理'],
      ['Size Chart', '尺码表'],
    ] as const) {
      const r = assessQuality(source, translated)
      expect(r.warnings, `${source} -> ${translated}`).not.toContain('too-short')
    }
  })

  it('still flags a truncated CJK translation', () => {
    const r = assessQuality(
      'Machine wash cold with like colors, tumble dry low, do not bleach',
      '洗',
    )
    expect(r.warnings).toContain('too-short')
  })

  it('does not flag a verbose Latin translation of a dense CJK source', () => {
    // The reverse direction: 3 Han characters are worth ~7 Latin letters, so
    // an 18-character English rendering must not read as 6x too long.
    const r = assessQuality('尺寸表', 'Size Chart')
    expect(r.warnings).not.toContain('too-long')
  })
})

describe('assessBatchQuality', () => {
  it('averages the unit-level scores and dedupes warnings', () => {
    const r = assessBatchQuality([
      { sourceText: 'hello', translatedText: '你好' },
      { sourceText: 'world', translatedText: '' },
    ])
    expect(r.warnings).toContain('empty')
    expect(r.overallScore).toBeCloseTo(0.5, 1)
  })

  it('returns a clean report for an empty batch', () => {
    const r = assessBatchQuality([])
    expect(r.overallScore).toBe(1)
    expect(r.warnings).toEqual([])
  })
})
