import { describe, expect, it, vi } from 'vitest'
import { skill } from '../src/index'
import type { SkillContext } from '@genoffice/agent-skills'

const fakeCtx = (content: string): SkillContext => ({
  invocationId: 'i',
  user: { id: 'u', locale: 'en-US', permissions: [] },
  workspace: { files: [] },
  llm: { chat: vi.fn().mockResolvedValue({ content }), streamChat: (async function* () { yield { delta: content, type: 'done' } })() },
  storage: { get: async () => undefined, set: async () => {}, delete: async () => true, has: async () => false, clear: async () => {} },
  emitProgress: () => {},
  cancel: () => {},
  cancelled: false,
})

describe('@genoffice/skill-text-summarize', () => {
  it('declares a stable id and triggers', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects empty text', async () => {
    await expect(skill.execute(fakeCtx('hi'), { text: '' })).rejects.toThrow(/text/)
    await expect(skill.execute(fakeCtx('hi'), { text: '   ' })).rejects.toThrow(/text/)
  })

  it('rejects non-string text', async () => {
    await expect(skill.execute(fakeCtx('hi'), { text: 42 })).rejects.toThrow(/text/)
  })

  it('returns the LLM summary and computes a sane ratio', async () => {
    const source = 'word '.repeat(200) // 200 tokens
    const out = await skill.execute(fakeCtx('a short summary'), { text: source })
    expect(out.summary).toBe('a short summary')
    expect(typeof out.ratio).toBe('number')
    expect((out.ratio as number)).toBeLessThan(1)
  })

  it('rethrows PROVIDER_FAILURE when LLM returns empty', async () => {
    await expect(skill.execute(fakeCtx(''), { text: 'hello world' })).rejects.toThrow(/empty/i)
  })
})
