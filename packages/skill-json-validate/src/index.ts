/**
 * @genoffice/skill-json-validate — validate JSON text against a small
 * JSON-schema-style rule set (similar to skill-yaml-validate but for JSON).
 */

import type { SkillContext, SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

export type SkillErrorCode =
  | 'INVALID_ARGUMENT' | 'PERMISSION_DENIED' | 'NOT_FOUND' | 'TIMEOUT'
  | 'CANCELLED' | 'PROVIDER_FAILURE' | 'INTERNAL'

export class SkillError extends Error {
  readonly code: SkillErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: SkillErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'SkillError'
  }
}

export interface JsonSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'
  required?: string[]
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: Array<string | number | boolean | null>
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  integer?: boolean
}

export interface JsonValidationError {
  path: string
  code: 'TYPE_MISMATCH' | 'REQUIRED' | 'ENUM_MISMATCH' | 'TOO_SHORT' | 'TOO_LONG' | 'BELOW_MIN' | 'ABOVE_MAX' | 'NOT_INTEGER' | 'INVALID_JSON'
  message: string
}

export interface JsonValidationResult {
  ok: boolean
  errors: JsonValidationError[]
}

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: JsonValidationError[]): void {
  const actual = typeOf(value)
  if (actual !== schema.type) {
    errors.push({ path, code: 'TYPE_MISMATCH', message: `expected ${schema.type} but got ${actual}` })
    return
  }
  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push({ path, code: 'ENUM_MISMATCH', message: `value not in enum ${JSON.stringify(schema.enum)}` })
  }
  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push({ path, code: 'TOO_SHORT', message: `length ${value.length} < minLength ${schema.minLength}` })
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push({ path, code: 'TOO_LONG', message: `length ${value.length} > maxLength ${schema.maxLength}` })
    }
  }
  if (schema.type === 'number' && typeof value === 'number') {
    if (schema.integer && !Number.isInteger(value)) {
      errors.push({ path, code: 'NOT_INTEGER', message: `${value} is not an integer` })
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, code: 'BELOW_MIN', message: `${value} < minimum ${schema.minimum}` })
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, code: 'ABOVE_MAX', message: `${value} > maximum ${schema.maximum}` })
    }
  }
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const req of schema.required ?? []) {
      if (!(req in obj)) {
        errors.push({ path: path ? `${path}.${req}` : req, code: 'REQUIRED', message: `missing required key "${req}"` })
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) validateNode(obj[key], sub, path ? `${path}.${key}` : key, errors)
    }
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    const itemSchema = schema.items
    if (itemSchema) {
      value.forEach((item, idx) => validateNode(item, itemSchema, `${path}[${idx}]`, errors))
    }
  }
}

function validateJson(text: string, schema: JsonSchema): JsonValidationResult {
  const errors: JsonValidationError[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return { ok: false, errors: [{ path: '', code: 'INVALID_JSON', message: (err as Error).message }] }
  }
  validateNode(parsed, schema, '', errors)
  return { ok: errors.length === 0, errors }
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.json-validate',
  version: '0.1.0',
  name: { 'en-US': 'Validate JSON', 'zh-CN': '校验 JSON' },
  description: {
    'en-US': 'Parses JSON text and validates it against a small JSON-schema-style rule set.',
    'zh-CN': '解析 JSON 文本并按 JSON-Schema 风格的小型规则集进行校验。',
  },
  triggers: ['validate json', 'check json', 'json 校验', '检查 json'],
  inputs: [
    { name: 'json', schema: { type: 'string', required: true, description: { 'en-US': 'JSON text', 'zh-CN': 'JSON 文本' } }, required: true },
    { name: 'schema', schema: { type: 'object', properties: {} as Record<string, never>, required: true, description: { 'en-US': 'Validation schema', 'zh-CN': '校验规则' } } as never, required: true },
  ],
  outputs: [
    { name: 'ok', schema: { type: 'boolean' } },
    { name: 'errors', schema: { type: 'array', items: { type: 'object', properties: {} as Record<string, never> } } as never },
  ],
  tags: ['json', 'validation', 'lint'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.json !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'json must be a string')
    }
    if (!rawInputs.schema || typeof rawInputs.schema !== 'object') {
      throw new SkillError('INVALID_ARGUMENT', 'schema must be an object')
    }
    const result = validateJson(rawInputs.json, rawInputs.schema as JsonSchema)
    return { ok: result.ok, errors: result.errors }
  },
}

const pkg: SkillPackage = { skill }
export default pkg
export { pkg, skill, validateJson }
