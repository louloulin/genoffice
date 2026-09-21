import { describe, expect, it, vi } from 'vitest'
import { skill } from '../src/index'
import type { SkillContext } from '@genoffice/agent-skills'

const fakeCtx = (mapped: Record<string, string>): SkillContext => ({
  invocationId: 'i',
  user: { id: 'u', locale: 'en-US', permissions: [] },
  workspace: { files: [] },
  llm: {
    chat: vi.fn(async (msgs) => ({ content: mapped[messagesKey(msgs)] ?? '' })),
    streamChat: (async function* () { yield { delta: '', type: 'done' } })(),
  },
  storage: { get: async () => undefined, set: async () => {}, delete: async () => true, has: async () => false, clear: async () => {} },
  emitProgress: () => {},
  cancel: () => {},
  cancelled: false,
})

function messagesKey(msgs: Array<{ text: string }>): string { return msgs[0]?.text ?? '' }

describe('@genoffice/skill-text-translate-pairs', () => {
  it('declares a stable id and triggers', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects empty pairs array', async () => {
    await expect(skill.execute(fakeCtx({}), { pairs: [], sourceLang: 'en', targetLang: 'fr' })).rejects.toThrow(/pairs/)
  })

  it('rejects non-array pairs', async () => {
    await expect(skill.execute(fakeCtx({}), { pairs: 'x', sourceLang: 'en', targetLang: 'fr' })).rejects.toThrow(/pairs/)
  })

  it('rejects invalid pair shape', async () => {
    await expect(skill.execute(fakeCtx({}), { pairs: [{ id: 1 }], sourceLang: 'en', targetLang: 'fr' })).rejects.toThrow(/invalid pair/)
  })

  it('translates each pair and preserves placeholders', async () => {
    const ctx = fakeCtx({
      'Hello ⟦P0⟧, welcome!': 'Bonjour ⟦P0⟧, bienvenue!',
      'Submit': 'Envoyer',
    })
    const out = await skill.execute(ctx, {
      pairs: [
        { id: '1', source: 'Hello {name}, welcome!' },
        { id: '2', source: 'Submit' },
      ],
      sourceLang: 'en-US',
      targetLang: 'fr-FR',
    })
    expect((out.translations as Array<{ target: string }>)[0].target).toBe('Bonjour {name}, bienvenue!')
    expect((out.translations as Array<{ target: string }>)[1].target).toBe('Envoyer')
    expect(out.count).toBe(2)
  })
})
