import { describe, expect, it } from 'vitest'
import { diffText, renderUnified } from '../src/index'

describe('diffText', () => {
  it('returns no hunks for identical input', () => {
    expect(diffText('a\nb\nc', 'a\nb\nc')).toEqual([])
  })

  it('detects a single-line insert', () => {
    const hunks = diffText('a\nb\nc', 'a\nX\nb\nc')
    expect(hunks.length).toBe(1)
    expect(hunks[0].lines.some((l) => l.op === 'insert' && l.text === 'X')).toBe(true)
  })

  it('detects a single-line delete', () => {
    const hunks = diffText('a\nb\nc', 'a\nc')
    expect(hunks.length).toBe(1)
    expect(hunks[0].lines.some((l) => l.op === 'delete' && l.text === 'b')).toBe(true)
  })

  it('detects a replacement', () => {
    const hunks = diffText('a\nb\nc', 'a\nB\nc')
    expect(hunks.length).toBe(1)
    const ops = hunks[0].lines.filter((l) => l.text === 'b' || l.text === 'B')
    expect(ops.some((l) => l.op === 'delete')).toBe(true)
    expect(ops.some((l) => l.op === 'insert')).toBe(true)
  })

  it('keeps `context` equal lines around each change', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const newText = ['a', 'b', 'c', 'X', 'e', 'f', 'g'].join('\n')
    const hunks = diffText(oldText, newText, { context: 2 })
    const hunk = hunks[0]
    const equals = hunk.lines.filter((l) => l.op === 'equal').length
    expect(equals).toBeLessThanOrEqual(4) // 2 above + 2 below
  })

  it('produces two hunks for two separate changes', () => {
    const hunks = diffText('a\nb\nc\nd\ne\nf', 'a\nX\nc\nd\nY\nf')
    expect(hunks.length).toBe(2)
  })
})

describe('renderUnified', () => {
  it('renders a unified-diff string', () => {
    const hunks = diffText('a\nb', 'a\nB')
    const out = renderUnified(hunks)
    expect(out).toContain('@@')
    expect(out).toContain('-b')
    expect(out).toContain('+B')
  })

  it('returns empty string for no changes', () => {
    expect(renderUnified([])).toBe('')
  })
})
