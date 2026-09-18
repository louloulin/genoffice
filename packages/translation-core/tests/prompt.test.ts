import { describe, expect, it } from 'vitest'

import {
  buildTranslateSystemPrompt,
  buildTranslationPrompt,
  extractTranslationText,
  normalizeSourceLang,
} from '../src/prompt'

describe('buildTranslateSystemPrompt', () => {
  it('mentions source / target languages and the preserve-format rule', () => {
    const sys = buildTranslateSystemPrompt({
      sourceLang: 'auto',
      targetLang: 'zh-CN',
      preserveFormat: true,
    })
    expect(sys).toMatch(/Source language: Auto-detect\./)
    expect(sys).toMatch(/Target language: Simplified Chinese\./)
    expect(sys).toMatch(/Preserve the original formatting/)
  })

  it('switches off the preserve rule when requested', () => {
    const sys = buildTranslateSystemPrompt({
      sourceLang: 'en-US',
      targetLang: 'ja-JP',
      preserveFormat: false,
    })
    expect(sys).toMatch(/Return only the translated text/)
    expect(sys).not.toMatch(/Preserve the original formatting/)
  })
})

describe('buildTranslationPrompt', () => {
  it('wraps the source in <source_text> delimiters', () => {
    const p = buildTranslationPrompt('Hello')
    expect(p).toContain('<source_text>\nHello\n</source_text>')
    expect(p).toContain('Translate the literal text')
  })
})

describe('extractTranslationText', () => {
  it('strips <think> blocks', () => {
    expect(extractTranslationText('<think>chain of thought</think>Hello')).toBe('Hello')
    expect(extractTranslationText('<think>still going\nmulti-line</think>\nDone')).toBe('Done')
  })

  it('returns null for empty after stripping', () => {
    expect(extractTranslationText('<think>only thoughts</think>')).toBeNull()
    expect(extractTranslationText('   \n  ')).toBeNull()
  })

  it('returns the trimmed text when there is no think block', () => {
    expect(extractTranslationText('  Hello world  ')).toBe('Hello world')
  })
})

describe('normalizeSourceLang', () => {
  it('maps undefined / "auto" to "auto"', () => {
    expect(normalizeSourceLang(undefined)).toBe('auto')
    expect(normalizeSourceLang('auto')).toBe('auto')
  })
  it('passes through a real code', () => {
    expect(normalizeSourceLang('en-US')).toBe('en-US')
  })
})

describe('buildTranslateSystemPrompt shape guards', () => {
  it('does not throw when glossaryCategory is a non-string', () => {
    // A number or array used to throw `opts.glossaryCategory.trim is not a
    // function` from inside the system-prompt builder — the prompt is built
    // even though the bucket is meaningless, and the renderer gets a sane
    // (bucket-less) translation instead of a 500.
    expect(() =>
      buildTranslateSystemPrompt({
        sourceLang: 'auto',
        targetLang: 'zh-CN',
        preserveFormat: true,
        glossaryCategory: 7 as unknown as string,
      }),
    ).not.toThrow()
    expect(() =>
      buildTranslateSystemPrompt({
        sourceLang: 'auto',
        targetLang: 'zh-CN',
        preserveFormat: true,
        glossaryCategory: {} as unknown as string,
      }),
    ).not.toThrow()
  })

  it('does not throw when sourceLang is a non-string', () => {
    expect(() =>
      buildTranslateSystemPrompt({
        sourceLang: 7 as unknown as string,
        targetLang: 'zh-CN',
        preserveFormat: true,
      }),
    ).not.toThrow()
  })
})

