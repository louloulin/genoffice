/**
 * @genoffice/skill-markdown-format — a standalone Skill that formats Markdown.
 *
 * Implements the `SkillPackage` contract from `@genoffice/agent-skills`.
 * Hosts load it via `registry.register(skill)` or by listing it in
 * `genoffice.skills.json`.
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

type BulletMarker = '-' | '*' | '+'

interface MarkdownFormatInputs {
  markdown: string
  bulletMarker?: BulletMarker
  maxHeadingLevel?: number
}

interface MarkdownFormatOutputs {
  markdown: string
  changes: number
}

let changes = 0

function normalizeHeadings(text: string, maxLevel: number): string {
  // The trailing `(?=\n|$)` lookahead avoids consuming a final `\n`
  // character when the line ends with `\n` (multiline `$` matches at end of
  // string and before each `\n`, and `\s*$` would happily eat that `\n`).
  return text.replace(/^(#+)\s*([^\n][^\n]*?)\s*#*(?=\n|$)/gm, (_match, hashes: string, title: string) => {
    const level = Math.min(hashes.length, maxLevel)
    const cleanedTitle = title.trim().replace(/\s*#+\s*$/, '').trim()
    return `${'#'.repeat(level)} ${cleanedTitle}`
  })
}

function normalizeBullets(text: string, marker: BulletMarker): string {
  return text.replace(/^(\s*)([-*+])\s+/gm, (_m, indent: string) => `${indent}${marker} `)
}

function normalizeCodeFences(text: string): string {
  return text.replace(/^```\s*$/gm, '```text')
}

interface DedupeResult {
  text: string
  refs: Array<{ id: string; label: string; url: string }>
}

function dedupeLinks(text: string): DedupeResult {
  // First pass: collect (label,url) → count
  const refCounts = new Map<string, number>()
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(text)) !== null) {
    const key = `${m[1]}|${m[2]}`
    refCounts.set(key, (refCounts.get(key) ?? 0) + 1)
  }
  // Second pass: convert repeat usages into reference style with stable id
  const usedIds = new Set<string>()
  const refs: Array<{ id: string; label: string; url: string }> = []
  const newText = text.replace(linkRe, (label: string, url: string) => {
    const key = `${label}|${url}`
    if ((refCounts.get(key) ?? 0) < 2) return `[${label}](${url})`
    let id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'link'
    if (usedIds.has(id)) {
      let n = 2
      while (usedIds.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }
    usedIds.add(id)
    refs.push({ id, label, url })
    changes++
    return `[${label}][${id}]`
  })
  return { text: newText, refs }
}

function appendLinkReferences(text: string, refs: Array<{ id: string; label: string; url: string }>): string {
  if (refs.length === 0) return text
  const block = refs.map((r) => `[${r.id}]: ${r.url}`).join('\n')
  return `${text.trimEnd()}\n\n${block}\n`
}

function normalizeWhitespace(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
}

function stripOrphanMarkers(text: string): string {
  // Strip stray ** / __ runs that aren't paired. We use a global replace with
  // a simple count check per line — if a line has an odd number of runs, all
  // runs on that line are dropped (safer than guessing which side is
  // unmatched; we'd rather lose a marker than eat legitimate text).
  let out = text
  for (const marker of ['**', '__']) {
    const ch = marker[0]
    const escaped = ch === '*' ? '\\*' : ch
    const re = new RegExp(`${escaped}{2}`, 'g')
    const lines = out.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const matches = lines[i].match(re) || []
      if (matches.length % 2 === 1) {
        lines[i] = lines[i].replace(re, '')
      }
    }
    out = lines.join('\n')
  }
  return out
}

function formatMarkdown(inputs: MarkdownFormatInputs): MarkdownFormatOutputs {
  changes = 0
  const maxLevel = inputs.maxHeadingLevel ?? 6
  const marker = inputs.bulletMarker ?? '-'
  let out = inputs.markdown
  const before = out
  out = normalizeWhitespace(out)
  if (out !== before) changes++
  const prev1 = out
  out = normalizeHeadings(out, maxLevel)
  if (out !== prev1) changes++
  const prev2 = out
  out = normalizeBullets(out, marker)
  if (out !== prev2) changes++
  const prev3 = out
  out = normalizeCodeFences(out)
  if (out !== prev3) changes++
  const { text: deduped, refs } = dedupeLinks(out)
  out = deduped
  out = appendLinkReferences(out, refs)
  const prev4 = out
  out = stripOrphanMarkers(out)
  if (out !== prev4) changes++
  return { markdown: out, changes }
}

const skill: SkillDefinition = {
  id: 'genoffice.skill.markdown-format',
  version: '0.1.0',
  name: {
    'en-US': 'Format Markdown',
    'zh-CN': '格式化 Markdown',
  },
  description: {
    'en-US': 'Normalises heading levels, list markers, code fences, link style, and whitespace in a Markdown document.',
    'zh-CN': '规范化 Markdown 文档的标题级别、列表标记、代码块语言、链接样式与空白。',
  },
  triggers: ['format markdown', 'normalise markdown', '整理 markdown', '规范化 markdown'],
  inputs: [
    {
      name: 'markdown',
      schema: { type: 'string', required: true, description: { 'en-US': 'Source Markdown text', 'zh-CN': '源 Markdown 文本' } },
      required: true,
    },
    {
      name: 'bulletMarker',
      schema: {
        type: 'enum',
        values: [
          { value: '-', label: { 'en-US': 'Dash', 'zh-CN': '短横' } },
          { value: '*', label: { 'en-US': 'Asterisk', 'zh-CN': '星号' } },
          { value: '+', label: { 'en-US': 'Plus', 'zh-CN': '加号' } },
        ],
        default: '-',
      },
      description: { 'en-US': 'Bullet marker to use for list items', 'zh-CN': '列表项使用的标记' },
    },
    {
      name: 'maxHeadingLevel',
      schema: { type: 'number', min: 1, max: 6, integer: true, default: 6 },
      description: { 'en-US': 'Cap heading depth', 'zh-CN': '最大标题层级' },
    },
  ],
  outputs: [
    { name: 'markdown', schema: { type: 'string' } },
    { name: 'changes', schema: { type: 'number' } },
  ],
  tags: ['formatting', 'markdown', 'linter'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const markdown = rawInputs.markdown
    if (typeof markdown !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'markdown must be a string')
    }
    const bulletMarker = (rawInputs.bulletMarker as BulletMarker | undefined) ?? '-'
    const maxHeadingLevel = typeof rawInputs.maxHeadingLevel === 'number' ? rawInputs.maxHeadingLevel : 6
    const result = formatMarkdown({ markdown, bulletMarker, maxHeadingLevel })
    return { markdown: result.markdown, changes: result.changes }
  },
}

const pkg: SkillPackage = {
  skill,
}

export default pkg
export { pkg, skill }
