/**
 * @genoffice/skill-text-translate — a standalone Skill that translates text
 * between BCP-47 languages via the host's LLM.
 *
 * Implements the `SkillPackage` contract from `@genoffice/agent-skills`.
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

type Domain = 'general' | 'legal' | 'medical' | 'software'

interface TranslateInputs {
  text: string
  target: string
  source?: string
  domain?: Domain
  preserveFormatting?: boolean
}

const DOMAIN_PROMPTS: Record<Domain, string> = {
  general: 'Use clear, idiomatic language.',
  legal: 'Use formal legal terminology; preserve quoted clauses verbatim.',
  medical: 'Use precise medical terminology; do not paraphrase dosage instructions.',
  software: 'Use developer-facing terminology; keep code identifiers unchanged.',
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.text-translate',
  version: '0.1.0',
  name: {
    'en-US': 'Translate Text',
    'zh-CN': '文本翻译',
  },
  description: {
    'en-US': 'Translates text between BCP-47 languages using the host LLM, with optional domain hint.',
    'zh-CN': '通过宿主 LLM 按 BCP-47 语言标签翻译文本，可选专业领域提示。',
  },
  triggers: ['translate', '翻译'],
  inputs: [
    {
      name: 'text',
      schema: { type: 'string', required: true, description: { 'en-US': 'Source text', 'zh-CN': '源文本' } },
      required: true,
    },
    {
      name: 'target',
      schema: { type: 'string', required: true, minLength: 2, maxLength: 10, description: { 'en-US': 'BCP-47 target language', 'zh-CN': 'BCP-47 目标语言' } },
      required: true,
    },
    {
      name: 'source',
      schema: { type: 'string', minLength: 2, maxLength: 10, description: { 'en-US': 'BCP-47 source language', 'zh-CN': 'BCP-47 源语言' } },
    },
    {
      name: 'domain',
      schema: {
        type: 'enum',
        values: [
          { value: 'general', label: { 'en-US': 'General', 'zh-CN': '通用' } },
          { value: 'legal', label: { 'en-US': 'Legal', 'zh-CN': '法律' } },
          { value: 'medical', label: { 'en-US': 'Medical', 'zh-CN': '医学' } },
          { value: 'software', label: { 'en-US': 'Software', 'zh-CN': '软件' } },
        ],
        default: 'general',
      },
      description: { 'en-US': 'Domain hint', 'zh-CN': '专业领域提示' },
    },
    {
      name: 'preserveFormatting',
      schema: { type: 'boolean', default: false },
      description: { 'en-US': 'Preserve line breaks / markdown structure', 'zh-CN': '保留换行 / Markdown 结构' },
    },
  ],
  outputs: [
    { name: 'translation', schema: { type: 'string' } },
    { name: 'detectedSource', schema: { type: 'string' } },
  ],
  tags: ['text', 'translate', 'i18n', 'ai'],
  execute: async (ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const text = rawInputs.text
    const target = rawInputs.target
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new SkillError('INVALID_ARGUMENT', 'text must be a non-empty string')
    }
    if (typeof target !== 'string' || target.length < 2) {
      throw new SkillError('INVALID_ARGUMENT', 'target must be a BCP-47 language tag')
    }
    const source = typeof rawInputs.source === 'string' && rawInputs.source.length > 0 ? rawInputs.source : 'auto-detect'
    const domain = (rawInputs.domain as Domain | undefined) ?? 'general'
    const preserve = rawInputs.preserveFormatting === true

    const sourceClause = source === 'auto-detect' ? 'The source language is unknown; detect it first.' : `The source language is ${source}.`
    const formatClause = preserve ? ' Preserve line breaks and any Markdown formatting.' : ''
    const system = `You are a precise translator. ${sourceClause} Translate the user's text into ${target}. ${DOMAIN_PROMPTS[domain]} Return only the translation — no commentary.${formatClause}`
    const result = await ctx.llm.chat([{ role: 'user', text }], { temperature: 0.1 })
    const translation = (result.content ?? '').trim()
    if (!translation) {
      throw new SkillError('PROVIDER_FAILURE', 'LLM returned an empty translation')
    }
    return {
      translation,
      detectedSource: source === 'auto-detect' ? 'unknown' : source,
    }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }
