/**
 * Unit tests for the composer slash-command model. All pure — no DOM, no
 * React. These guard the trigger rules (which are easy to get subtly wrong and
 * very annoying when they misfire inside a URL) and the ranking/tie-break
 * behaviour the menu depends on.
 */
import { describe, expect, it } from 'vitest'

import {
  activeSlashQuery,
  applyComposerCommand,
  filterComposerCommands,
  firstEnabledIndex,
  groupComposerCommands,
  nextEnabledIndex,
  type ComposerCommand,
} from '../src/chat/composer-commands'

const cmd = (
  over: Partial<ComposerCommand> & Pick<ComposerCommand, 'id' | 'trigger' | 'kind'>,
): ComposerCommand => ({
  label: over.trigger,
  ...over,
})

describe('activeSlashQuery', () => {
  it('detects a bare slash at the start', () => {
    expect(activeSlashQuery('/', 1)).toEqual({ query: '', start: 0, end: 1 })
  })

  it('detects a partial trigger', () => {
    expect(activeSlashQuery('/sum', 4)).toEqual({ query: 'sum', start: 0, end: 4 })
  })

  it('detects a command after whitespace', () => {
    expect(activeSlashQuery('rewrite this /pol', 17)).toEqual({
      query: 'pol',
      start: 13,
      end: 17,
    })
  })

  it('ignores a slash mid-word', () => {
    // "and/or" — the slash has a letter before it, so it is not a command
    expect(activeSlashQuery('this and/or', 12)).toBeNull()
  })

  it('ignores a URL', () => {
    expect(activeSlashQuery('see https://exa', 15)).toBeNull()
  })

  it('ignores an absolute path', () => {
    expect(activeSlashQuery('/usr/bin/ls', 11)).toBeNull()
  })

  it('ignores a path-looking fragment even at the start', () => {
    // a second slash inside the chunk means path, not command
    expect(activeSlashQuery('/usr/bin', 8)).toBeNull()
  })

  it('allows CJK triggers', () => {
    expect(activeSlashQuery('/翻译', 3)).toEqual({ query: '翻译', start: 0, end: 3 })
  })

  it('rejects punctuation that means "path"', () => {
    expect(activeSlashQuery('/a.b', 4)).toBeNull()
  })

  it('returns null while composing (IME)', () => {
    expect(activeSlashQuery('/sum', 4, true)).toBeNull()
  })

  it('reads only the fragment ending at the caret', () => {
    // caret is before the trailing text, so the trailing " tail" is ignored
    expect(activeSlashQuery('/sum tail', 4)).toEqual({ query: 'sum', start: 0, end: 4 })
  })

  it('returns null for out-of-range carets', () => {
    expect(activeSlashQuery('/sum', -1)).toBeNull()
    expect(activeSlashQuery('/sum', 99)).toBeNull()
  })
})

describe('filterComposerCommands', () => {
  const commands: ComposerCommand[] = [
    cmd({
      id: 'translate',
      trigger: 'translate',
      kind: 'insert',
      group: '技能',
      keywords: ['翻译', 'i18n'],
    }),
    cmd({
      id: 'summarize',
      trigger: 'summarize',
      kind: 'insert',
      group: '动作',
      keywords: ['总结'],
    }),
    cmd({ id: 'style', trigger: 'style', kind: 'insert', description: 'translation style rules' }),
  ]

  it('returns everything for an empty query', () => {
    expect(filterComposerCommands(commands, '').map((c) => c.id)).toEqual([
      'translate',
      'summarize',
      'style',
    ])
  })

  it('ranks a trigger prefix above a description hit', () => {
    expect(filterComposerCommands(commands, 'tran').map((c) => c.id)).toEqual([
      'translate',
      'style',
    ])
  })

  it('matches keywords', () => {
    expect(filterComposerCommands(commands, '总结').map((c) => c.id)).toEqual(['summarize'])
  })

  it('is case-insensitive', () => {
    expect(filterComposerCommands(commands, 'SUM').map((c) => c.id)).toEqual(['summarize'])
  })

  it('preserves input order for equal scores (stable)', () => {
    const tied: ComposerCommand[] = [
      cmd({ id: 'a', trigger: 'x', kind: 'insert', description: 'hit' }),
      cmd({ id: 'b', trigger: 'y', kind: 'insert', description: 'hit' }),
    ]
    expect(filterComposerCommands(tied, 'hit').map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterComposerCommands(commands, 'zzz')).toEqual([])
  })
})

describe('applyComposerCommand', () => {
  it('replaces the fragment and appends a trailing space', () => {
    const at = activeSlashQuery('please /sum', 11)!
    const result = applyComposerCommand(
      'please /sum',
      at,
      cmd({ id: 's', trigger: 'sum', kind: 'insert', insert: 'Summarize this document' }),
    )
    expect(result.value).toBe('please Summarize this document ')
    expect(result.caret).toBe(result.value.length)
  })

  it('keeps text that follows the caret', () => {
    const at = activeSlashQuery('/sum tail', 4)!
    const result = applyComposerCommand(
      '/sum tail',
      at,
      cmd({ id: 's', trigger: 'sum', kind: 'insert', insert: 'SUM' }),
    )
    // no doubled space, and the caret lands right after the inserted template
    expect(result.value).toBe('SUM tail')
    expect(result.caret).toBe(3)
  })

  it('removes the fragment for run commands', () => {
    const at = activeSlashQuery('/clear', 6)!
    const result = applyComposerCommand(
      '/clear',
      at,
      cmd({ id: 'c', trigger: 'clear', kind: 'run' }),
    )
    expect(result.value).toBe('')
    expect(result.caret).toBe(0)
  })

  it('does not double a space the insert already has', () => {
    const at = activeSlashQuery('/sum', 4)!
    const result = applyComposerCommand(
      '/sum',
      at,
      cmd({ id: 's', trigger: 'sum', kind: 'insert', insert: 'Summarize ' }),
    )
    expect(result.value).toBe('Summarize ')
  })

  it('falls back to the trigger when insert is missing', () => {
    const at = activeSlashQuery('/sum', 4)!
    const result = applyComposerCommand(
      '/sum',
      at,
      cmd({ id: 's', trigger: 'sum', kind: 'insert' }),
    )
    expect(result.value).toBe('sum ')
  })
})

describe('groupComposerCommands', () => {
  it('preserves first-appearance order and buckets by group', () => {
    const commands: ComposerCommand[] = [
      cmd({ id: 'a', trigger: 'a', kind: 'insert', group: '技能' }),
      cmd({ id: 'b', trigger: 'b', kind: 'insert', group: '动作' }),
      cmd({ id: 'c', trigger: 'c', kind: 'insert', group: '技能' }),
      cmd({ id: 'd', trigger: 'd', kind: 'insert' }),
    ]
    const grouped = groupComposerCommands(commands, '其他')
    expect(grouped.map((g) => g.group)).toEqual(['技能', '动作', '其他'])
    expect(grouped[0]!.commands.map((c) => c.id)).toEqual(['a', 'c'])
  })
})

describe('nextEnabledIndex / firstEnabledIndex', () => {
  const commands: ComposerCommand[] = [
    cmd({ id: 'a', trigger: 'a', kind: 'insert', disabled: true }),
    cmd({ id: 'b', trigger: 'b', kind: 'insert' }),
    cmd({ id: 'c', trigger: 'c', kind: 'insert', disabled: true }),
    cmd({ id: 'd', trigger: 'd', kind: 'insert' }),
  ]

  it('skips disabled rows going down', () => {
    expect(nextEnabledIndex(commands, 1, 1)).toBe(3)
  })

  it('wraps around', () => {
    expect(nextEnabledIndex(commands, 3, 1)).toBe(1)
  })

  it('skips disabled rows going up', () => {
    expect(nextEnabledIndex(commands, 1, -1)).toBe(3)
  })

  it('returns the current index when nothing is enabled', () => {
    const allOff = commands.map((c) => ({ ...c, disabled: true }))
    expect(nextEnabledIndex(allOff, 0, 1)).toBe(0)
  })

  it('returns -1 for an empty list', () => {
    expect(nextEnabledIndex([], 0, 1)).toBe(-1)
  })

  it('finds the first enabled row', () => {
    expect(firstEnabledIndex(commands)).toBe(1)
    expect(firstEnabledIndex([])).toBe(-1)
  })
})
