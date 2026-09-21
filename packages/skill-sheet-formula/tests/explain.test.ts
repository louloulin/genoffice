import { describe, expect, it } from 'vitest'
import { explainFormula, tokenise } from '../src/index'

describe('tokenise', () => {
  it('emits a function token followed by paren-open', () => {
    const t = tokenise('SUM(A1:A10)')
    expect(t[0]).toMatchObject({ kind: 'function', value: 'SUM' })
    expect(t[1]).toMatchObject({ kind: 'paren-open' })
  })

  it('captures a range as one token', () => {
    const t = tokenise('A1:B3')
    expect(t[0]).toMatchObject({ kind: 'range', value: 'A1:B3' })
  })

  it('recognises a string literal', () => {
    const t = tokenise('"hello"')
    expect(t[0]).toMatchObject({ kind: 'string', value: '"hello"' })
  })

  it('recognises a number with decimal', () => {
    const t = tokenise('1.5')
    expect(t[0]).toMatchObject({ kind: 'number', value: '1.5' })
  })
})

describe('explainFormula', () => {
  it('summarises a simple SUM', () => {
    const r = explainFormula('=SUM(A1:A10)')
    expect(r.summary).toMatch(/Sum of values/)
    expect(r.functions).toHaveLength(1)
    expect(r.functions[0].name).toBe('SUM')
    expect(r.references).toContain('A1:A10')
    expect(r.issues).toHaveLength(0)
  })

  it('flags an unmatched closing paren', () => {
    const r = explainFormula('=SUM(A1))')
    expect(r.issues.some((i) => i.severity === 'error' && i.message.includes('unmatched closing'))).toBe(true)
  })

  it('flags an unmatched opening paren', () => {
    const r = explainFormula('=SUM(A1')
    expect(r.issues.some((i) => i.severity === 'error' && i.message.includes('unmatched opening'))).toBe(true)
  })

  it('warns on unknown functions', () => {
    const r = explainFormula('=FOOBAR(1)')
    expect(r.issues.some((i) => i.severity === 'warning' && i.message.includes('unknown function FOOBAR'))).toBe(true)
  })

  it('warns on division by literal zero', () => {
    const r = explainFormula('=A1/0')
    expect(r.issues.some((i) => i.message.includes('division by literal zero'))).toBe(true)
  })

  it('detects VLOOKUP', () => {
    const r = explainFormula('=VLOOKUP("x", A:B, 2, FALSE)')
    expect(r.functions[0].name).toBe('VLOOKUP')
    expect(r.functions[0].description).toMatch(/Vertical lookup/)
  })

  it('handles a formula without leading `=`', () => {
    const r = explainFormula('SUM(1,2)')
    expect(r.functions[0].name).toBe('SUM')
  })

  it('handles an empty formula', () => {
    const r = explainFormula('')
    expect(r.summary).toMatch(/Empty/)
  })

  it('throws on non-string', () => {
    // @ts-expect-error testing runtime guard
    expect(() => explainFormula(123)).toThrow(/formula must be a string/)
  })
})
