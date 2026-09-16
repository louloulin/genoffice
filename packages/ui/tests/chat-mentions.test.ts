/**
 * Unit tests for the @-mention model in `chat/mentions.ts`.
 *
 * Pure-function coverage only — the picker UI is exercised in
 * `ai-composer-interaction.test.ts` through the AiComposer.
 */
import { describe, expect, it } from 'vitest'
import {
  activeMentionQuery,
  applyMentionPick,
  filterMentionEntries,
  flattenMentionGroups,
  indexOfMention,
  mentionInsertText,
  nextEnabledMentionIndex,
  parseMentionTokens,
  type MentionEntry,
} from '../src/chat/mentions'

const entries: readonly MentionEntry[] = [
  {
    id: 'file-summary',
    trigger: 'summary',
    label: '工艺单汇总.pdf',
    description: '/Downloads/KERRITS.pdf',
    group: 'Files',
    kind: 'file',
    keywords: ['pdf', '汇总'],
  },
  {
    id: 'file-fabric',
    trigger: 'fabric',
    label: '面料清单.xlsx',
    description: '/Downloads/fabrics.xlsx',
    group: 'Files',
    kind: 'file',
  },
  {
    id: 'block-doc',
    trigger: 'doc',
    label: '当前文档',
    description: 'project.docx — 第 12 段',
    group: 'Blocks',
    kind: 'block',
  },
  {
    id: 'skill-translate',
    trigger: 'translate',
    label: '翻译技能',
    description: '调用 translate-skill 工具',
    group: 'Skills',
    kind: 'skill',
    disabled: true,
  },
]

describe('activeMentionQuery', () => {
  it('detects a leading @query', () => {
    expect(activeMentionQuery('@sum', 4)).toEqual({ query: 'sum', start: 0, end: 4 })
  })
  it('detects a query after whitespace', () => {
    expect(activeMentionQuery('look at @sum', 12)).toEqual({ query: 'sum', start: 8, end: 12 })
  })
  it('returns null inside a URL or path', () => {
    expect(activeMentionQuery('https://x.com/@user', 17)).toBeNull()
    expect(activeMentionQuery('/usr/bin/@thing', 14)).toBeNull()
  })
  it('returns null mid-word (email)', () => {
    expect(activeMentionQuery('alice@bob', 9)).toBeNull()
  })
  it('returns an empty query when the caret is right after the @', () => {
    // The @ is at index 0; caret=1 sits after it with nothing typed yet.
    expect(activeMentionQuery('@sum', 1)).toEqual({ query: '', start: 0, end: 1 })
  })
  it('returns null while composing', () => {
    expect(activeMentionQuery('@sum', 4, true)).toBeNull()
  })
  it('allows CJK characters in the query', () => {
    expect(activeMentionQuery('@工艺', 3)).toEqual({ query: '工艺', start: 0, end: 3 })
  })
  it('rejects punctuation inside the query', () => {
    expect(activeMentionQuery('@sum!', 5)).toBeNull()
  })
  it('rejects a second @ inside the chunk', () => {
    expect(activeMentionQuery('@@user', 6)).toBeNull()
  })
})

describe('filterMentionEntries', () => {
  it('returns every group when query is empty', () => {
    const r = filterMentionEntries(entries, '')
    expect(r.groups.flatMap((g) => g.entries).map((e) => e.id)).toEqual([
      'file-summary',
      'file-fabric',
      'block-doc',
      'skill-translate',
    ])
  })
  it('matches by trigger prefix first', () => {
    const r = filterMentionEntries(entries, 'sum')
    expect(r.groups[0]?.entries[0]?.id).toBe('file-summary')
  })
  it('falls back to label/description/keywords', () => {
    const r = filterMentionEntries(entries, 'pdf')
    expect(r.groups[0]?.entries.map((e) => e.id)).toContain('file-summary')
  })
  it('drops entries with score 0', () => {
    const r = filterMentionEntries(entries, 'zzzzzz')
    expect(r.groups).toHaveLength(0)
  })
  it('respects group declaration order', () => {
    const r = filterMentionEntries(entries, 'fab')
    expect(r.groups.map((g) => g.group)).toEqual(['Files'])
  })
  it('returns firstEnabledIndex skipping disabled rows', () => {
    const r = filterMentionEntries(entries, '')
    expect(r.firstEnabledIndex).toBe(0)
  })
  it('keeps disabled rows in the list but excludes them from firstEnabledIndex', () => {
    const disabledOnly: readonly MentionEntry[] = [
      { id: 'd1', trigger: 'one', label: 'one', group: 'g', kind: 'file', disabled: true },
      { id: 'd2', trigger: 'two', label: 'two', group: 'g', kind: 'file', disabled: true },
    ]
    const r = filterMentionEntries(disabledOnly, '')
    expect(r.firstEnabledIndex).toBe(0) // fallback when nothing enabled
  })
})

describe('applyMentionPick', () => {
  it('replaces @query with @label and places the caret after', () => {
    const q = activeMentionQuery('see @sum and more', 8)!
    const entry = entries.find((e) => e.id === 'file-summary')!
    // the pick inserts '@label ' (with trailing space); the surrounding
    // whitespace of the original query stays, hence the double space.
    const out = applyMentionPick('see @sum and more', q, entry)
    expect(out.value).toBe('see @工艺单汇总.pdf  and more')
    expect(out.caret).toBe('see @工艺单汇总.pdf '.length)
  })
})

describe('mentionInsertText', () => {
  it('uses label by default, trigger as fallback', () => {
    expect(mentionInsertText(entries[0]!)).toBe('@工艺单汇总.pdf ')
  })
  it('falls back to trigger when label is empty', () => {
    const e = { id: 'x', trigger: 'thing', label: '', kind: 'file' as const }
    expect(mentionInsertText(e)).toBe('@thing ')
  })
})

describe('nextEnabledMentionIndex', () => {
  const flat = flattenMentionGroups(filterMentionEntries(entries, '').groups)
  it('skips disabled rows going down', () => {
    expect(nextEnabledMentionIndex(flat, 2, 1)).toBe(0) // wraps past disabled skill
  })
  it('wraps on up', () => {
    expect(nextEnabledMentionIndex(flat, 0, -1)).toBe(2)
  })
})

describe('indexOfMention', () => {
  it('finds the entry by id in the flattened order', () => {
    const groups = filterMentionEntries(entries, '').groups
    expect(indexOfMention(groups, 'block-doc')).toBe(2)
  })
  it('returns -1 when missing', () => {
    expect(indexOfMention([], 'whatever')).toBe(-1)
  })
})

describe('parseMentionTokens', () => {
  it('resolves mention tokens to known entries', () => {
    const tokens = parseMentionTokens(
      'see @工艺单汇总.pdf and @fabric now',
      entries,
    )
    expect(tokens.map((t) => t.id)).toEqual(['file-summary', 'file-fabric'])
    expect(tokens[0]?.kind).toBe('file')
  })
  it('ignores unknown labels', () => {
    const tokens = parseMentionTokens('@nope @fabric', entries)
    expect(tokens.map((t) => t.id)).toEqual(['file-fabric'])
  })
})
