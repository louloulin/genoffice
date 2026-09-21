/**
 * @genoffice/skill-text-translate-pairs — translate TMX-style parallel text
 * pairs between BCP-47 languages using the host's LLM.
 *
 * The Skill preserves placeholder tokens (e.g. `{varName}`, `%s`, `{0}`)
 * by extracting them before the call and reinjecting after, so the LLM
 * never sees variable substitutions.
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

interface Pair { id: string; source: string; sourceLang?: string }

interface TranslatePairsInputs {
  pairs: Pair[]
  sourceLang: string
  targetLang: string
}

const PLACEHOLDER_RE = /(\{\w+\}|%\w?|%\(\w+\)s|\{\d+\})/g

function extractPlaceholders(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = []
  const masked = text.replace(PLACEHOLDER_RE, (m) => {
    tokens.push(m)
    return `⟦P${tokens.length - 1}⟧`
  })
  return { masked, tokens }
}

function reinjectPlaceholders(text: string, tokens: string[]): string {
  return text.replace(/⟦P(\d+)⟧/g, (_m, idx) => tokens[Number(idx)] ?? '')
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.text-translate-pairs',
  version: '0.1.0',
  name: { 'en-US': 'Translate Parallel Pairs', 'zh-CN': '翻译平行语料对' },
  description: {
    'en-US': 'Translates TMX-style parallel text pairs between BCP-47 languages via the host LLM; preserves placeholders.',
    'zh-CN': '通过宿主 LLM 按 BCP-47 语言标签翻译平行语料对，保留占位符。',
  },
  triggers: ['translate pairs', 'translate tmx', '翻译语料对'],
  inputs: [
    { name: 'pairs', schema: { type: 'array', items: { type: 'object', properties: {} as Record<string, never> }, required: true, description: { 'en-US': 'Pairs to translate', 'zh-CN': '待翻译对' } } as never, required: true },
    { name: 'sourceLang', schema: { type: 'string', required: true, minLength: 2, maxLength: 10 }, required: true },
    { name: 'targetLang', schema: { type: 'string', required: true, minLength: 2, maxLength: 10 }, required: true },
  ],
  outputs: [
    { name: 'translations', schema: { type: 'array', items: { type: 'object', properties: {} as Record<string, never> } } as never },
    { name: 'count', schema: { type: 'number' } },
  ],
  tags: ['text', 'translate', 'pairs', 'tmx', 'i18n', 'ai'],
  execute: async (ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const pairs = rawInputs.pairs
    const sourceLang = rawInputs.sourceLang
    const targetLang = rawInputs.targetLang
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new SkillError('INVALID_ARGUMENT', 'pairs must be a non-empty array')
    }
    if (typeof sourceLang !== 'string' || typeof targetLang !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'sourceLang and targetLang must be strings')
    }
    const translations: Array<{ id: string; source: string; target: string }> = []
    for (const pair of pairs) {
      if (!pair || typeof pair !== 'object' || typeof (pair as Pair).source !== 'string' || typeof (pair as Pair).id !== 'string') {
        throw new SkillError('INVALID_ARGUMENT', `invalid pair: ${JSON.stringify(pair)}`)
      }
      const p = pair as Pair
      const { masked, tokens } = extractPlaceholders(p.source)
      const system = `You are a precise translator. Translate each line from ${sourceLang} to ${targetLang}. The user provides one masked line at a time (⟦P<n>⟧ are placeholders — translate literally, do not substitute). Return only the translation.`
      const res = await ctx.llm.chat([{ role: 'user', text: masked }], { temperature: 0.1 })
      const translated = reinjectPlaceholders((res.content ?? '').trim(), tokens)
      translations.push({ id: p.id, source: p.source, target: translated })
    }
    return { translations, count: translations.length }
  },
}

const pkg: SkillPackage = { skill }
export default pkg
export { pkg, skill }
