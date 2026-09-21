import { describe, expect, it } from 'vitest'
import { skill, parseYaml, validateYaml, type YamlSchema } from '../src/index'

describe('@genoffice/skill-yaml-validate', () => {
  it('declares a stable id and at least one trigger', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects non-string yaml input', async () => {
    await expect(skill.execute({} as never, { yaml: 1, schema: { type: 'object' } })).rejects.toThrow(/yaml/)
  })

  it('rejects missing schema', async () => {
    await expect(skill.execute({} as never, { yaml: 'k: v' })).rejects.toThrow(/schema/)
  })

  it('validates a simple object', async () => {
    const out = await skill.execute({} as never, {
      yaml: 'name: Alice\nage: 30\n',
      schema: {
        type: 'object',
        required: ['name', 'age'],
        properties: {
          name: { type: 'string', minLength: 1 },
          age: { type: 'number', minimum: 0, maximum: 150 },
        },
      },
    })
    expect(out.ok).toBe(true)
    expect(out.errors).toEqual([])
  })

  it('reports missing required keys', async () => {
    const out = await skill.execute({} as never, {
      yaml: 'name: Alice\n',
      schema: { type: 'object', required: ['name', 'age'] },
    })
    expect(out.ok).toBe(false)
    const errs = out.errors as Array<{ code: string; path: string }>
    expect(errs.some((e) => e.code === 'REQUIRED' && e.path === 'age')).toBe(true)
  })

  it('reports type mismatch', async () => {
    const out = await skill.execute({} as never, {
      yaml: 'name: 123\n',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    })
    expect(out.ok).toBe(false)
    const errs = out.errors as Array<{ code: string }>
    expect(errs.some((e) => e.code === 'TYPE_MISMATCH')).toBe(true)
  })

  it('validates arrays of items', async () => {
    const schema: YamlSchema = {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        },
      },
    }
    const out = await skill.execute({} as never, {
      yaml: 'items:\n  - id: a\n  - id: b\n',
      schema,
    })
    expect(out.ok).toBe(true)
  })

  it('parseYaml handles nested structures', () => {
    const tree = parseYaml('user:\n  name: Alice\n  tags:\n    - admin\n    - ops\n')
    expect(tree).toEqual({ user: { name: 'Alice', tags: ['admin', 'ops'] } })
  })

  it('validateYaml returns enum mismatch', () => {
    const r = validateYaml('level: intermediate', {
      type: 'object',
      properties: { level: { type: 'string', enum: ['beginner', 'advanced'] } },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === 'ENUM_MISMATCH')).toBe(true)
  })
})
