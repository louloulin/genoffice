/**
 * @genoffice/skill-yaml-to-json — convert between YAML and JSON text.
 * Uses the same minimal YAML parser as @genoffice/skill-yaml-validate.
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

type YamlNode = string | number | boolean | null | YamlNode[] | { [key: string]: YamlNode }

function parseScalar(raw: string): YamlNode {
  if (raw === 'null' || raw === '~' || raw === '') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw)
  return raw
}

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
          i++
          arr.push(parseBlock(indent + 2))
        } else if (valueAfterDash.includes(':')) {
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
        obj[key] = parseBlock(indent + 2)
      } else {
        obj[key] = parseScalar(rest)
      }
    }
    return obj
  }
  return parseBlock(0)
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.yaml-to-json',
  version: '0.1.0',
  name: { 'en-US': 'YAML ↔ JSON', 'zh-CN': 'YAML 与 JSON 互转' },
  description: {
    'en-US': 'Convert text between YAML and JSON representations (block style, no flow / anchors).',
    'zh-CN': '在 YAML 与 JSON 表示之间转换文本（块格式，不支持 flow / 锚点）。',
  },
  triggers: ['yaml to json', 'json to yaml', 'yaml 转 json', 'json 转 yaml'],
  inputs: [
    {
      name: 'text',
      schema: { type: 'string', required: true, description: { 'en-US': 'Source text (YAML or JSON)', 'zh-CN': '源文本（YAML 或 JSON）' } },
      required: true,
    },
    {
      name: 'from',
      schema: {
        type: 'enum',
        values: [
          { value: 'yaml', label: { 'en-US': 'YAML' } },
          { value: 'json', label: { 'en-US': 'JSON' } },
        ],
        required: true,
        description: { 'en-US': 'Source format', 'zh-CN': '源格式' },
      },
      required: true,
    },
    { name: 'indent', schema: { type: 'number', min: 0, max: 8, integer: true, default: 2 }, description: { 'en-US': 'JSON indent (when from=yaml)', 'zh-CN': 'JSON 缩进（当 from=yaml 时）' } },
  ],
  outputs: [
    { name: 'text', schema: { type: 'string' } },
    { name: 'format', schema: { type: 'string' } },
  ],
  tags: ['yaml', 'json', 'convert'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const text = rawInputs.text
    const from = rawInputs.from
    if (typeof text !== 'string') throw new SkillError('INVALID_ARGUMENT', 'text must be a string')
    if (from !== 'yaml' && from !== 'json') {
      throw new SkillError('INVALID_ARGUMENT', "from must be 'yaml' or 'json'")
    }
    const indent = typeof rawInputs.indent === 'number' ? rawInputs.indent : 2
    if (from === 'yaml') {
      const parsed = parseYaml(text)
      return { text: JSON.stringify(parsed, null, indent), format: 'json' }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      throw new SkillError('INVALID_ARGUMENT', `invalid JSON: ${(err as Error).message}`)
    }
    return { text: JSON.stringify(parsed), format: 'json' }
  },
}

const pkg: SkillPackage = { skill }
export default pkg
export { pkg, skill, parseYaml }
