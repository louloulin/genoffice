/**
 * Tests for the working-mode model. The directives are the part that actually
 * changes model behaviour, so they get asserted on content (not just presence):
 * a future edit that drops the "do not modify" sentence from Ask mode would
 * silently make Ask mode destructive.
 */
import { describe, expect, it } from 'vitest'

import {
  CHAT_MODES,
  CHAT_MODE_SPECS,
  DEFAULT_CHAT_MODE,
  chatModeDirective,
  chatModeSpec,
  composeSystemSuffix,
  isChatMode,
  isReadOnlyMode,
  normalizeChatMode,
  skillDirective,
} from '../src/chat/modes'

describe('chat modes', () => {
  it('exposes exactly ask / craft / plan', () => {
    expect([...CHAT_MODES]).toEqual(['ask', 'craft', 'plan'])
  })

  it('defaults to craft', () => {
    expect(DEFAULT_CHAT_MODE).toBe('craft')
  })

  it('every mode has a label key, hint key and non-empty directive', () => {
    for (const id of CHAT_MODES) {
      const spec = CHAT_MODE_SPECS[id]
      expect(spec.id).toBe(id)
      expect(spec.labelKey).toMatch(/^ai/)
      expect(spec.hintKey).toMatch(/^ai/)
      expect(spec.directive.length).toBeGreaterThan(40)
    }
  })

  it('Ask explicitly forbids writes', () => {
    const ask = chatModeSpec('ask').directive
    expect(ask).toContain('Do NOT modify')
    expect(ask).toContain('Never call a tool that writes')
  })

  it('Plan defers execution until the user confirms', () => {
    const plan = chatModeSpec('plan').directive
    expect(plan).toContain('Do not call a single writing tool')
    expect(plan).toContain('only then execute')
  })

  it('Craft leads with the action', () => {
    expect(chatModeSpec('craft').directive).toContain('Carry out the request end to end')
  })

  it('chatModeSpec falls back to the default for unknown input', () => {
    expect(chatModeSpec(undefined).id).toBe(DEFAULT_CHAT_MODE)
    expect(chatModeSpec('nonsense' as never).id).toBe(DEFAULT_CHAT_MODE)
  })

  it('chatModeDirective returns the English instruction', () => {
    expect(chatModeDirective('ask')).toBe(CHAT_MODE_SPECS.ask.directive)
    expect(chatModeDirective(undefined)).toBe(CHAT_MODE_SPECS.craft.directive)
  })

  it('isChatMode narrows correctly', () => {
    expect(isChatMode('plan')).toBe(true)
    expect(isChatMode('PLAN')).toBe(false)
    expect(isChatMode(7)).toBe(false)
  })

  it('normalizeChatMode repairs bad persisted values', () => {
    expect(normalizeChatMode('plan')).toBe('plan')
    expect(normalizeChatMode('')).toBe('craft')
    expect(normalizeChatMode(null)).toBe('craft')
  })

  it('isReadOnlyMode is true only for ask', () => {
    expect(isReadOnlyMode('ask')).toBe(true)
    expect(isReadOnlyMode('craft')).toBe(false)
    expect(isReadOnlyMode('plan')).toBe(false)
  })
})

describe('composeSystemSuffix', () => {
  it('joins non-empty parts with a blank line', () => {
    expect(composeSystemSuffix('A', 'B')).toBe('A\n\nB')
  })

  it('drops empty / nullish / false parts', () => {
    expect(composeSystemSuffix('A', '', undefined, null, false, 'B')).toBe('A\n\nB')
  })

  it('trims each part', () => {
    expect(composeSystemSuffix('  A  ', '\n  B  ')).toBe('A\n\nB')
  })

  it('returns an empty string when everything is empty', () => {
    expect(composeSystemSuffix('', undefined, false)).toBe('')
  })
})

describe('skillDirective', () => {
  it('names the skill and asks for its workflow', () => {
    const d = skillDirective({ name: '去AI味', description: '去除 AI 腔调' })
    expect(d).toContain('# Active skill: 去AI味')
    expect(d).toContain('去除 AI 腔调')
    expect(d).toContain('authoritative method')
  })

  it('appends instructions when present', () => {
    const d = skillDirective({ name: 'x', instructions: '1. check\n2. rewrite' })
    expect(d).toContain('1. check')
  })

  it('omits the purpose line when there is no description', () => {
    expect(skillDirective({ name: 'x' })).not.toContain('Purpose:')
  })
})
