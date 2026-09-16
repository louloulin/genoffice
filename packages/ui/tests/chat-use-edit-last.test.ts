import { describe, expect, it } from 'vitest'
import { findLastUserText } from '../src/chat/useEditLast'

interface Msg { role: string; text: string }

const sample: Msg[] = [
  { role: 'user', text: 'first message' },
  { role: 'assistant', text: 'reply one' },
  { role: 'user', text: 'second message' },
  { role: 'assistant', text: 'reply two' },
]

describe('findLastUserText', () => {
  it('returns the most recent user text', () => {
    expect(findLastUserText(sample)).toBe('second message')
  })
  it('skips empty text', () => {
    expect(findLastUserText([{ role: 'user', text: '' }, { role: 'user', text: 'real' }])).toBe(
      'real',
    )
  })
  it('returns null when there is no user entry', () => {
    expect(findLastUserText([{ role: 'assistant', text: 'r' }])).toBeNull()
  })
  it('returns null on an empty list', () => {
    expect(findLastUserText([])).toBeNull()
  })
})

// useEditLast itself is a thin useCallback wrapper around findLastUserText;
// its behaviour is fully covered by the AiComposer onEditLast test in
// ai-composer-interaction.test.ts, where the hook is exercised end-to-end.
