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

describe('@genoffice/skill-text-translate', () => {
  it('declares a stable id and triggers', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers).toContain('translate')
  })

  it('rejects empty text', async () => {
    await expect(skill.execute(fakeCtx('hi'), { text: '', target: 'en-US' })).rejects.toThrow(/text/)
  })

  it('rejects missing target', async () => {
    await expect(skill.execute(fakeCtx('hi'), { text: 'hello' })).rejects.toThrow(/target/)
    await expect(skill.execute(fakeCtx('hi'), { text: 'hello', target: 'e' })).rejects.toThrow(/target/)
  })

  it('returns translation and echoes the source language', async () => {
    const out = await skill.execute(fakeCtx('bonjour'), {
      text: 'hello',
      target: 'fr-FR',
      source: 'en-US',
    })
    expect(out.translation).toBe('bonjour')
    expect(out.detectedSource).toBe('en-US')
  })

  it('falls back to "unknown" when source is omitted', async () => {
    const out = await skill.execute(fakeCtx('hola'), { text: 'hello', target: 'es-ES' })
    expect(out.detectedSource).toBe('unknown')
  })

  it('rethrows PROVIDER_FAILURE when LLM returns empty', async () => {
    await expect(skill.execute(fakeCtx(''), { text: 'hello', target: 'es-ES' })).rejects.toThrow(/empty/i)
  })
})
