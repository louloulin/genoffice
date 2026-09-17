import { describe, expect, it } from 'vitest'

import {
  LANGUAGES,
  dominantScript,
  englishLabelFor,
  getLanguage,
  isAlreadyInLanguage,
  scriptOfLanguage,
} from '../src/languages'

describe('getLanguage', () => {
  it('returns the canonical entry for known codes', () => {
    expect(getLanguage('zh-CN')?.englishLabel).toBe('Simplified Chinese')
    expect(getLanguage('en-US')?.label).toBe('English')
    expect(getLanguage('ja-JP')?.englishLabel).toBe('Japanese')
  })

  it('falls back to the family when the region is unknown', () => {
    expect(getLanguage('en-GB')?.value).toBe('en-US')
    expect(getLanguage('pt-BR')?.value).toBe('pt-PT')
  })

  it('returns null for empty / nullish / unknown input', () => {
    expect(getLanguage(undefined)).toBeNull()
    expect(getLanguage(null)).toBeNull()
    expect(getLanguage('')).toBeNull()
    expect(getLanguage('xx-YY')).toBeNull()
  })
})

describe('englishLabelFor', () => {
  it('uses the English label for prompts', () => {
    expect(englishLabelFor('zh-CN')).toBe('Simplified Chinese')
    expect(englishLabelFor('auto')).toBe('Auto-detect')
  })

  it('falls back to the raw code when the language is unknown', () => {
    expect(englishLabelFor('xx-YY')).toBe('xx-YY')
  })

  it('handles nullish input', () => {
    expect(englishLabelFor(undefined)).toBe('Auto-detect')
    expect(englishLabelFor(null)).toBe('Auto-detect')
  })
})

describe('LANGUAGES', () => {
  it('has a unique value for every entry', () => {
    const seen = new Set<string>()
    for (const l of LANGUAGES) {
      expect(seen.has(l.value)).toBe(false)
      seen.add(l.value)
    }
  })

  it('contains auto + a balanced set of locales', () => {
    expect(LANGUAGES.find((l) => l.value === 'auto')).toBeTruthy()
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(10)
  })
})

describe('dominantScript', () => {
  it('picks the script with the most letters', () => {
    expect(dominantScript('花型有方向性。')).toBe('han')
    expect(dominantScript('The pattern is directional.')).toBe('latin')
    expect(dominantScript('居中，顺纱向')).toBe('han')
    expect(dominantScript('FEATURES POWERMESH FACING')).toBe('latin')
    // latin letters win on raw count even when the Chinese is the part that
    // matters — `dominantScript` is the plain majority, the tolerance lives in
    // `isAlreadyInLanguage`
    expect(dominantScript('KERRITS 主吊牌')).toBe('latin')
    expect(dominantScript('1. KERRITS 尺码吊牌')).toBe('latin')
    expect(dominantScript('CAD款号：50466 尺码：XXS-2X')).toBe('latin')
    expect(dominantScript('Перевести текст')).toBe('cyrillic')
    expect(dominantScript('こんにちは')).toBe('kana')
    expect(dominantScript('안녕하세요')).toBe('hangul')
  })

  it('reports "other" for strings with no letters', () => {
    expect(dominantScript('16-4408')).toBe('other')
    expect(dominantScript('3/16"')).toBe('other')
    expect(dominantScript('  --  ')).toBe('other')
    expect(dominantScript('')).toBe('other')
  })
})

describe('scriptOfLanguage', () => {
  it('maps the offered languages onto their writing systems', () => {
    expect(scriptOfLanguage('zh-CN')).toBe('han')
    expect(scriptOfLanguage('zh-TW')).toBe('han')
    expect(scriptOfLanguage('ja-JP')).toBe('kana')
    expect(scriptOfLanguage('ko-KR')).toBe('hangul')
    expect(scriptOfLanguage('en-US')).toBe('latin')
    expect(scriptOfLanguage('ru-RU')).toBe('cyrillic')
    expect(scriptOfLanguage('ar-SA')).toBe('arabic')
    expect(scriptOfLanguage('hi-IN')).toBe('devanagari')
    expect(scriptOfLanguage('th-TH')).toBe('thai')
  })

  it('returns null for auto / unknown / nullish', () => {
    expect(scriptOfLanguage('auto')).toBeNull()
    expect(scriptOfLanguage('xx-YY')).toBeNull()
    expect(scriptOfLanguage(undefined)).toBeNull()
  })
})

describe('isAlreadyInLanguage', () => {
  it('treats text in the target script as already translated', () => {
    // mixed lines: the Chinese half is the half that must survive untouched
    expect(isAlreadyInLanguage('花型有方向性。', 'zh-CN')).toBe(true)
    expect(isAlreadyInLanguage('居中，顺纱向', 'zh-CN')).toBe(true)
    expect(isAlreadyInLanguage('CAD款号：50466 尺码：XXS-2X', 'zh-CN')).toBe(true)
    expect(isAlreadyInLanguage('1. KERRITS 尺码吊牌', 'zh-CN')).toBe(true)
    expect(isAlreadyInLanguage('The pattern is directional.', 'en-US')).toBe(true)
  })

  it('sends text in another script to the model', () => {
    expect(isAlreadyInLanguage('The pattern is directional.', 'zh-CN')).toBe(false)
    expect(isAlreadyInLanguage('FEATURES POWERMESH FACING', 'zh-CN')).toBe(false)
    expect(isAlreadyInLanguage('花型有方向性。', 'en-US')).toBe(false)
    // mostly-English lines that happen to quote one Chinese word still need work
    expect(isAlreadyInLanguage('3" WIDE CONTOURED WB, FACING IN A面料', 'zh-CN')).toBe(false)
  })

  it('leaves brand-name-heavy lines to the model rather than guessing', () => {
    // Correctness rule: claim "already translated" only once the target script
    // reaches a third of the line's letters. A line that is mostly a brand
    // name still goes to the model, which returns it unchanged — a wasted
    // call, but not a corruption. Guessing the other way would risk skipping
    // real English.
    expect(isAlreadyInLanguage('KERRITS 主吊牌', 'zh-CN')).toBe(false)
    expect(isAlreadyInLanguage('2" TACH-IT 枪针', 'zh-CN')).toBe(false)
  })

  it('accepts kanji as Japanese, since Japanese mixes scripts', () => {
    expect(isAlreadyInLanguage('図面', 'ja-JP')).toBe(true)
    expect(isAlreadyInLanguage('こんにちは', 'ja-JP')).toBe(true)
    expect(isAlreadyInLanguage('図面', 'zh-CN')).toBe(true)
    // but Chinese does not accept kana
    expect(isAlreadyInLanguage('こんにちは', 'zh-CN')).toBe(false)
  })

  it('never claims a letterless string is already translated', () => {
    // measurements and colour codes have nothing to translate either way —
    // leave them to the model so the dictionary carries an explicit entry
    expect(isAlreadyInLanguage('16-4408', 'zh-CN')).toBe(false)
    expect(isAlreadyInLanguage('3/16"', 'zh-CN')).toBe(false)
  })

  it('returns false when the target language is unknown', () => {
    expect(isAlreadyInLanguage('花型有方向性。', 'auto')).toBe(false)
    expect(isAlreadyInLanguage('花型有方向性。', undefined)).toBe(false)
  })
})
