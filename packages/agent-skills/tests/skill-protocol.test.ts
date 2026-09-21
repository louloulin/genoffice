import { beforeEach, describe, expect, it } from 'vitest'
import {
  createSkillRegistry,
  SkillError,
  type SkillDefinition,
  type ProgressEvent,
  type SkillContext,
} from '../src/skill-protocol'

const def: SkillDefinition = {
  id: 'genoffice.skill.test.echo',
  version: '1.0.0',
  name: { 'en-US': 'Echo', 'zh-CN': '回声' },
  description: { 'en-US': 'Returns the input verbatim.', 'zh-CN': '原样返回输入。' },
  triggers: ['echo', '回声'],
  inputs: [
    { name: 'text', schema: { type: 'string' as const, required: true } },
  ],
  outputs: [
    { name: 'text', schema: { type: 'string' as const } },
  ],
  tags: ['test', 'demo'],
  execute: async (_ctx, inputs) => ({ text: String(inputs.text ?? '') }),
}

describe('createSkillRegistry', () => {
  it('registers and lists', () => {
    const reg = createSkillRegistry()
    reg.register(def)
    expect(reg.list()).toHaveLength(1)
    expect(reg.get('genoffice.skill.test.echo')).toBe(def)
  })

  it('rejects a definition without an id', () => {
    const reg = createSkillRegistry()
    expect(() => reg.register({ ...def, id: '' })).toThrow(/id required/)
  })

  it('rejects a definition without execute', () => {
    const reg = createSkillRegistry()
    expect(() => reg.register({ ...def, execute: undefined as never })).toThrow(/execute/)
  })

  it('rejects a definition with empty triggers', () => {
    const reg = createSkillRegistry()
    expect(() => reg.register({ ...def, triggers: [] })).toThrow(/triggers/)
  })

  it('matches by trigger substring case-insensitively', () => {
    const reg = createSkillRegistry()
    reg.register(def)
    expect(reg.match('please echo this')).toBe(def)
    expect(reg.match('ECHO ME')).toBe(def)
    expect(reg.match('not a match')).toBeUndefined()
  })

  it('matches by Chinese trigger', () => {
    const reg = createSkillRegistry()
    reg.register(def)
    expect(reg.match('请回声这段话')).toBe(def)
  })

  it('filters by tag', () => {
    const reg = createSkillRegistry()
    reg.register(def)
    expect(reg.byTag('demo')).toEqual([def])
    expect(reg.byTag('missing')).toEqual([])
  })

  it('unregisters by id', () => {
    const reg = createSkillRegistry()
    reg.register(def)
    expect(reg.unregister('genoffice.skill.test.echo')).toBe(true)
    expect(reg.unregister('genoffice.skill.test.echo')).toBe(false)
  })
})

describe('SkillError', () => {
  it('preserves code and message', () => {
    const err = new SkillError('TIMEOUT', 'took too long', { elapsedMs: 90000 })
    expect(err.code).toBe('TIMEOUT')
    expect(err.message).toBe('took too long')
    expect(err.details).toEqual({ elapsedMs: 90000 })
    expect(err.name).toBe('SkillError')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('SkillDefinition.execute', () => {
  it('passes inputs through and returns declared outputs', async () => {
    const ctx: SkillContext = {
      invocationId: 'inv-1',
      user: { id: 'u', locale: 'en-US', permissions: [] },
      workspace: { files: [], open: async () => { throw new SkillError('NOT_FOUND', 'no file') } },
      llm: {
        chat: async () => ({ content: '' }),
        streamChat: async function* () { yield { delta: '', type: 'done' as const } },
      },
      storage: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => false,
        has: async () => false,
        clear: async () => {},
      },
      emitProgress: () => {},
      cancel: () => {},
      cancelled: false,
    }
    const out = await def.execute(ctx, { text: 'hello' })
    expect(out).toEqual({ text: 'hello' })
  })
})

describe('ProgressEvent', () => {
  it('every phase is a string', () => {
    const phases: ProgressEvent['phase'][] = ['queued', 'started', 'progress', 'log', 'completed', 'failed']
    expect(phases).toHaveLength(6)
  })
})

import { getDefaultSkillRegistry, resetDefaultSkillRegistry, createSkillRegistry } from '../src/skill-protocol'

describe('getDefaultSkillRegistry', () => {
  beforeEach(() => resetDefaultSkillRegistry())

  it('returns the same instance across calls', () => {
    expect(getDefaultSkillRegistry()).toBe(getDefaultSkillRegistry())
  })

  it('returns a fresh instance after resetDefaultSkillRegistry', () => {
    const first = getDefaultSkillRegistry()
    resetDefaultSkillRegistry()
    const second = getDefaultSkillRegistry()
    expect(first).not.toBe(second)
  })

  it('is interchangeable with createSkillRegistry', () => {
    const reg = getDefaultSkillRegistry()
    expect(typeof reg.register).toBe('function')
    expect(typeof reg.list).toBe('function')
    expect(typeof reg.match).toBe('function')
    expect(typeof reg.byTag).toBe('function')
  })
})
