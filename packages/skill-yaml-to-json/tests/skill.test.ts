import { describe, expect, it } from 'vitest'
import { skill, parseYaml } from '../src/index'

describe('@genoffice/skill-yaml-to-json', () => {
  it('declares a stable id and triggers', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects non-string text', async () => {
    await expect(skill.execute({} as never, { text: 1, from: 'yaml' })).rejects.toThrow(/text/)
  })

  it('rejects unknown from value', async () => {
    await expect(skill.execute({} as never, { text: 'k: v', from: 'xml' })).rejects.toThrow(/from/)
  })

  it('yaml → json roundtrip', async () => {
    const out = await skill.execute({} as never, {
      text: 'name: Alice\nage: 30\n',
      from: 'yaml',
    })
    expect(out.format).toBe('json')
    const parsed = JSON.parse(out.text as string)
    expect(parsed).toEqual({ name: 'Alice', age: 30 })
  })

  it('parseYaml handles nested blocks', () => {
    const tree = parseYaml('user:\n  name: Alice\n  tags:\n    - admin\n')
    expect(tree).toEqual({ user: { name: 'Alice', tags: ['admin'] } })
  })
})
