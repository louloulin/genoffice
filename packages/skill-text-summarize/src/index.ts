/**
 * @genoffice/skill-text-summarize — a standalone Skill that summarises text
 * using the host's LLM (SkillContext.llm).
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

type Length = 'short' | 'medium' | 'long' | 'bullets'

interface SummarizeInputs {
  text: string
  length?: Length
  maxWords?: number
  language?: string
}

const LENGTH_TO_TARGET: Record<Length, { sentence: string; words: number }> = {
  short: { sentence: 'a single sentence (max 30 words)', words: 30 },
  medium: { sentence: 'a paragraph (3-5 sentences)', words: 120 },
  long: { sentence: 'a detailed summary (8-12 sentences)', words: 350 },
  bullets: { sentence: '5-8 bullet points prefixed with `- `', words: 200 },
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.text-summarize',
  version: '0.1.0',
  name: {
    'en-US': 'Summarize Text',
    'zh-CN': '文本摘要',
  },
  description: {
    'en-US': 'Produces a concise summary of a long text via the host LLM.',
    'zh-CN': '通过宿主 LLM 对长文本生成简洁摘要。',
  },
  triggers: ['summarize', 'summary', 'tldr', '摘要', '总结'],
  inputs: [
    {
      name: 'text',
      schema: { type: 'string', required: true, description: { 'en-US': 'Source text', 'zh-CN': '源文本' } },
      required: true,
    },
    {
      name: 'length',
      schema: {
        type: 'enum',
        values: [
          { value: 'short', label: { 'en-US': 'Short (1 sentence)', 'zh-CN': '简短（1 句）' } },
          { value: 'medium', label: { 'en-US': 'Medium (paragraph)', 'zh-CN': '中等（段落）' } },
          { value: 'long', label: { 'en-US': 'Long (detailed)', 'zh-CN': '详细' } },
          { value: 'bullets', label: { 'en-US': 'Bullets', 'zh-CN': '要点列表' } },
        ],
        default: 'medium',
      },
      description: { 'en-US': 'Target summary length / shape', 'zh-CN': '摘要长度 / 形式' },
    },
    {
      name: 'maxWords',
      schema: { type: 'number', min: 10, max: 2000, integer: true },
      description: { 'en-US': 'Soft cap on summary length (words)', 'zh-CN': '摘要字数上限' },
    },
    {
      name: 'language',
      schema: { type: 'string', minLength: 2, maxLength: 10 },
      description: { 'en-US': 'BCP-47 tag; default auto-detect', 'zh-CN': 'BCP-47 语言标签；默认自动识别' },
    },
  ],
  outputs: [
    { name: 'summary', schema: { type: 'string' } },
    { name: 'ratio', schema: { type: 'number' } },
  ],
  tags: ['text', 'summary', 'ai'],
  execute: async (ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const text = rawInputs.text
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new SkillError('INVALID_ARGUMENT', 'text must be a non-empty string')
    }
    const length = (rawInputs.length as Length | undefined) ?? 'medium'
    const target = LENGTH_TO_TARGET[length]
    const maxWords = typeof rawInputs.maxWords === 'number' ? rawInputs.maxWords : target.words
    const language = typeof rawInputs.language === 'string' ? rawInputs.language : ''

    const languageClause = language ? ` Write the summary in ${language}.` : ''
    const system = `You are a precise summariser. Produce ${target.sentence}, around ${maxWords} words.${languageClause} Stay faithful to the source; do not invent facts.`
    const result = await ctx.llm.chat([{ role: 'user', text }], { temperature: 0.2 })
    const summary = (result.content ?? '').trim()
    if (!summary) {
      throw new SkillError('PROVIDER_FAILURE', 'LLM returned an empty summary')
    }
    const sourceWords = text.split(/\s+/).length
    const summaryWords = summary.split(/\s+/).length
    const ratio = sourceWords === 0 ? 0 : Math.min(1, summaryWords / sourceWords)
    return { summary, ratio }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }
