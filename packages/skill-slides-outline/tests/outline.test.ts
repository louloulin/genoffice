import { describe, expect, it } from 'vitest'
import { buildOutline, splitSentences } from '../src/index'

describe('splitSentences', () => {
  it('splits on . ? !', () => {
    expect(splitSentences('A. B! C?')).toEqual(['A.', 'B!', 'C?'])
  })

  it('returns empty for empty input', () => {
    expect(splitSentences('')).toEqual([])
  })

  it('keeps the trailing sentence without terminator', () => {
    expect(splitSentences('Hello world')).toEqual(['Hello world'])
  })
})

describe('buildOutline', () => {
  it('returns empty slides for empty input', () => {
    const r = buildOutline('')
    expect(r.slides).toEqual([])
    expect(r.totalWords).toBe(0)
  })

  it('produces a single slide for short text', () => {
    const r = buildOutline('Cats are wonderful. They purr softly.')
    expect(r.slides.length).toBe(1)
    expect(r.slides[0].bullets.length).toBeGreaterThanOrEqual(1)
  })

  it('starts a new slide at a `#` heading', () => {
    const r = buildOutline('# Introduction\n\nFirst point. Second point.\n\n# Conclusion\n\nWrap up.')
    expect(r.slides.length).toBe(2)
    expect(r.slides[0].title.toLowerCase()).toContain('introduction')
    expect(r.slides[1].title.toLowerCase()).toContain('conclusion')
  })

  it('starts a new slide at a numbered heading', () => {
    const r = buildOutline('1. One. Two. Three.\n\n2. Four. Five.')
    expect(r.slides.length).toBeGreaterThanOrEqual(2)
  })

  it('caps bullets per slide', () => {
    const r = buildOutline('A. B. C. D. E. F. G. H.', { bulletsPerSlide: 3 })
    for (const slide of r.slides) {
      expect(slide.bullets.length).toBeLessThanOrEqual(3)
    }
  })

  it('respects the title length cap', () => {
    const r = buildOutline('# A very very very very very long title that should be trimmed\n\nBody.', { maxTitleWords: 4 })
    const titleWords = r.slides[0].title.replace('…', '').split(/\s+/).length
    expect(titleWords).toBeLessThanOrEqual(4)
  })

  it('throws SkillError on non-string', () => {
    // @ts-expect-error testing runtime guard
    expect(() => buildOutline(123)).toThrow(/text must be a string/)
  })
})
