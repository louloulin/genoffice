import { describe, expect, it } from 'vitest'
import { computeTokenCounter, estimateTokens } from '../src/chat/token-counter'

describe('estimateTokens', () => {
  it('counts CJK as ~1 token per char', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })
  it('counts ASCII as ~1 token per 4 chars', () => {
    expect(estimateTokens('hello world!')).toBe(3) // 12 chars → ceil(12/4)
  })
  it('handles mixed text', () => {
    const t = estimateTokens('hello 你好')
    // 6 ASCII chars (ceil 6/4 = 2) + 2 CJK = 4
    expect(t).toBe(4)
  })
  it('returns 0 for empty', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('computeTokenCounter', () => {
  it('produces an idle tone under 60%', () => {
    const c = computeTokenCounter('hello world', { budget: 1000 })
    expect(c.tone).toBe('idle')
    expect(c.ratio).toBeLessThan(0.6)
  })
  it('shifts to warn at 60%', () => {
    // 600 chars ASCII → 150 tokens; budget 200 → ratio 0.75 → warn
    const text = 'a'.repeat(600)
    const c = computeTokenCounter(text, { budget: 200 })
    expect(c.tone).toBe('warn')
  })
  it('shifts to danger at 85%', () => {
    const text = 'a'.repeat(800)
    const c = computeTokenCounter(text, { budget: 200 })
    expect(c.tone).toBe('danger')
  })
  it('formats labels in k notation for >1000', () => {
    const c = computeTokenCounter('a'.repeat(8000), { budget: 20000 })
    expect(c.label).toBe('2.0k / 20k')
  })
  it('handles 0-budget gracefully', () => {
    const c = computeTokenCounter('anything', { budget: 0 })
    expect(c.ratio).toBe(0)
    expect(c.tone).toBe('idle')
  })
  it('overrides thresholds', () => {
    // 800 chars ASCII = 200 tokens; budget 250 → 0.8 ratio, past dangerAt 0.5
    const c = computeTokenCounter('a'.repeat(800), { budget: 250, warnAt: 0.3, dangerAt: 0.5 })
    expect(c.tone).toBe('danger')
  })
})
