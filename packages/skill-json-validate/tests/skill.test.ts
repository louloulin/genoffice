import { describe, expect, it } from 'vitest'
import { skill, validateJson, type JsonSchema } from '../src/index'

describe('@genoffice/skill-json-validate', () => {
  it('declares a stable id and triggers', () => {
    expect(skill.id).toMatch(/^genoffice\.skill\./)
    expect(skill.triggers.length).toBeGreaterThan(0)
  })

  it('rejects non-string json', async () => {
    await expect(skill.execute({} as never, { json: 1, schema: { type: 'object' } })).rejects.toThrow(/json/)
  })

  it('rejects missing schema', async () => {
    await expect(skill.execute({} as never, { json: '{}' })).rejects.toThrow(/schema/)
  })

  it('validates a simple object', async () => {
    const out = await skill.execute({} as never, {
      json: '{"name":"Alice","age":30}',
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

  it('reports parse errors with INVALID_JSON code', () => {
    const r = validateJson('not json', { type: 'object' })
    expect(r.ok).toBe(false)
    expect(r.errors[0].code).toBe('INVALID_JSON')
  })

  it('reports missing required keys', () => {
    const schema: JsonSchema = { type: 'object', required: ['id'] }
    const r = validateJson('{}', schema)
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })
})
