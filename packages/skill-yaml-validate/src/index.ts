/**
 * @genoffice/skill-yaml-validate — a standalone Skill that validates YAML text
 * against a small JSON-schema-style rule set.
 *
 * Implements the `SkillPackage` contract from `@genoffice/agent-skills`.
 *
 * The YAML parser is intentionally minimal (no external runtime dep): it
 * handles indentation-based blocks, scalars (string/number/boolean/null),
 * block sequences (- item), and block mappings (key: value). It does NOT
 * handle flow style, anchors, tags, multi-doc, or complex keys — see the
 * README for the full scope.
 */

// Type-only import: SkillDefinition / SkillPackage / SkillContext live
// in @genoffice/agent-skills/skill-protocol. We declare a local SkillError
// here so the published package doesn't drag in the entire @genoffice/agent-skills
// source tree (which depends on @earendil-works/pi-coding-agent).
import type { SkillContext, SkillDefinition, SkillPackage } from '@genoffice/agent-skills'

export type SkillErrorCode =
  | 'INVALID_ARGUMENT'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_FAILURE'
  | 'INTERNAL'

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

// ──────────────────────────────────────────────────────────────────────────────
// Schema
// ──────────────────────────────────────────────────────────────────────────────

export type ScalarType = 'string' | 'number' | 'boolean' | 'null'

export interface YamlSchema {
  type: 'object' | 'array' | ScalarType
  required?: string[]
  properties?: Record<string, YamlSchema>
  items?: YamlSchema
  enum?: Array<string | number | boolean | null>
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  integer?: boolean
}

// ──────────────────────────────────────────────────────────────────────────────
// Validation result
// ──────────────────────────────────────────────────────────────────────────────

export interface YamlValidationError {
  /** Dotted path to the offending node (`root.items[0].name`). */
  path: string
  code:
    | 'TYPE_MISMATCH'
    | 'REQUIRED'
    | 'ENUM_MISMATCH'
    | 'TOO_SHORT'
    | 'TOO_LONG'
    | 'BELOW_MIN'
    | 'ABOVE_MAX'
    | 'NOT_INTEGER'
  message: string
}

export interface YamlValidationResult {
  ok: boolean
  errors: YamlValidationError[]
}

// ──────────────────────────────────────────────────────────────────────────────
// Tiny YAML parser (block style, indentation-based)
// ──────────────────────────────────────────────────────────────────────────────

type YamlNode = string | number | boolean | null | YamlNode[] | { [key: string]: YamlNode }

function parseScalar(raw: string): YamlNode {
  if (raw === 'null' || raw === '~' || raw === '') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  // Quoted string
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  // Number
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw)
  return raw
}

/**
 * Parse a YAML block-style document into a JS value.
 * Throws `SkillError('INVALID_ARGUMENT', …)` on syntax errors.
 */
function parseYaml(text: string): YamlNode {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
  let i = 0
  const parseBlock = (indent: number): YamlNode => {
    if (i >= lines.length) return null
    const cur = lines[i]
    const leading = cur.match(/^(\s*)/)?.[1].length ?? 0
    if (leading < indent) return null
    // Sequence?
    if (cur.slice(indent).startsWith('- ')) {
      const arr: YamlNode[] = []
      while (i < lines.length) {
        const line = lines[i]
        const ind = line.match(/^(\s*)/)?.[1].length ?? 0
        if (ind < indent) break
        if (ind > indent) {
          throw new SkillError('INVALID_ARGUMENT', `yaml: unexpected indent at line ${i + 1}`)
        }
        if (!line.slice(indent).startsWith('- ')) break
        const valueAfterDash = line.slice(indent + 2)
        if (valueAfterDash === '') {
          // nested block follows
          i++
          arr.push(parseBlock(indent + 2))
        } else if (valueAfterDash.includes(':')) {
          // Inline mapping start — keep the line, descend
          const inline = valueAfterDash
          lines[i] = ' '.repeat(indent + 2) + inline
          arr.push(parseBlock(indent + 2))
        } else {
          arr.push(parseScalar(valueAfterDash))
          i++
        }
      }
      return arr
    }
    // Mapping
    const obj: { [key: string]: YamlNode } = {}
    while (i < lines.length) {
      const line = lines[i]
      const ind = line.match(/^(\s*)/)?.[1].length ?? 0
      if (ind < indent) break
      if (ind > indent) {
        throw new SkillError('INVALID_ARGUMENT', `yaml: unexpected indent at line ${i + 1}`)
      }
      const body = line.slice(indent)
      const m = body.match(/^([^:]+):\s*(.*)$/)
      if (!m) {
        throw new SkillError('INVALID_ARGUMENT', `yaml: expected mapping at line ${i + 1}`)
      }
      const key = m[1].trim()
      const rest = m[2]
      i++
      if (rest === '') {
        // nested block follows
        const nested = parseBlock(indent + 2)
        obj[key] = nested
      } else {
        obj[key] = parseScalar(rest)
      }
    }
    return obj
  }
  return parseBlock(0)
}

// ──────────────────────────────────────────────────────────────────────────────
// Validator
// ──────────────────────────────────────────────────────────────────────────────

function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validateNode(value: unknown, schema: YamlSchema, path: string, errors: YamlValidationError[]): void {
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

function validateYaml(text: string, schema: YamlSchema): YamlValidationResult {
  const parsed = parseYaml(text)
  const errors: YamlValidationError[] = []
  validateNode(parsed, schema, '', errors)
  return { ok: errors.length === 0, errors }
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill manifest
// ──────────────────────────────────────────────────────────────────────────────

interface YamlValidateInputs {
  yaml: string
  schema: YamlSchema
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.yaml-validate',
  version: '0.1.0',
  name: {
    'en-US': 'Validate YAML',
    'zh-CN': '校验 YAML',
  },
  description: {
    'en-US': 'Parses YAML text and validates it against a small JSON-schema-style rule set.',
    'zh-CN': '解析 YAML 文本并按 JSON-Schema 风格的小型规则集进行校验。',
  },
  triggers: ['validate yaml', 'check yaml', 'yaml 校验', '检查 yaml'],
  inputs: [
    {
      name: 'yaml',
      schema: { type: 'string', required: true, description: { 'en-US': 'YAML text', 'zh-CN': 'YAML 文本' } } as never,
      required: true,
    },
    {
      name: 'schema',
      schema: { type: 'object', properties: {} as Record<string, never>, required: true, description: { 'en-US': 'Validation schema', 'zh-CN': '校验规则' } } as never,
      required: true,
    },
  ],
  outputs: [
    { name: 'ok', schema: { type: 'boolean' } },
    { name: 'errors', schema: { type: 'array', items: { type: 'object', properties: {} as Record<string, never> } } as never },
  ],
  tags: ['yaml', 'validation', 'lint'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.yaml !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'yaml must be a string')
    }
    if (!rawInputs.schema || typeof rawInputs.schema !== 'object') {
      throw new SkillError('INVALID_ARGUMENT', 'schema must be an object')
    }
    const result = validateYaml(rawInputs.yaml, rawInputs.schema as YamlSchema)
    return { ok: result.ok, errors: result.errors }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill, validateYaml, parseYaml }
