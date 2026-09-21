import { describe, expect, it } from 'vitest'
import { formatDoc } from '../src/index'

describe('formatDoc', () => {
  it('returns text unchanged when all defaults pass through', () => {
    const r = formatDoc('Hello, world.\nThis is fine.')
    expect(r.changed).toBe(false)
  })

  it('collapses multiple spaces into one', () => {
    const r = formatDoc('hello    world')
    expect(r.text).toBe('hello world')
    expect(r.stats.collapsedSpaces).toBe(3)
  })

  it('trims trailing whitespace on each line', () => {
    const r = formatDoc('foo   \nbar  \nbaz')
    expect(r.text).toBe('foo\nbar\nbaz')
    expect(r.stats.trimmedTrailing).toBe(5)
  })

  it('normalises CRLF and CR to LF', () => {
    const r = formatDoc('foo\r\nbar\r\nbaz')
    expect(r.text).toBe('foo\nbar\nbaz')
    expect(r.stats.normalisedLineEndings).toBe(2)
  })

  it('converts straight quotes to smart quotes', () => {
    const r = formatDoc('She said "hello".')
    expect(r.text).toBe('She said \u201Chello\u201D.')
    expect(r.stats.smartQuoteConversions).toBe(2)
  })

  it('opens smart quote after whitespace', () => {
    const r = formatDoc('the "best"')
    expect(r.text).toBe('the \u201Cbest\u201D')
  })

  it('collapses three or more blank lines into two', () => {
    const r = formatDoc('a\n\n\n\n\nb')
    expect(r.text).toBe('a\n\nb')
    expect(r.stats.blankLinesCollapsed).toBeGreaterThan(0)
  })

  it('option: smartQuotes off skips the conversion', () => {
    const r = formatDoc('"hello"', { smartQuotes: false })
    expect(r.text).toBe('"hello"')
    expect(r.stats.smartQuoteConversions).toBe(0)
  })

  it('option: collapseSpaces off skips the collapse', () => {
    const r = formatDoc('hello    world', { collapseSpaces: false })
    expect(r.text).toBe('hello    world')
    expect(r.stats.collapsedSpaces).toBe(0)
  })

  it('throws SkillError on non-string input', () => {
    // @ts-expect-error testing runtime guard
    expect(() => formatDoc(42)).toThrow(/text must be a string/)
  })
})
