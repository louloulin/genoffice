/**
 * @genoffice/skill-doc-format — a standalone Skill that normalises the
 * typography and whitespace of a plain-text document.
 *
 * Operations applied in order (each is gated by a flag in `options`):
 *
 *   - collapse whitespace runs (>= 2 spaces) into a single space
 *   - trim trailing whitespace on each line
 *   - normalise CRLF / CR to LF
 *   - convert straight quotes (' " `) to smart quotes (' ' " ")
 *   - collapse runs of > 2 consecutive newlines into exactly 2
 *
 * Implements the `SkillPackage` contract from `@genoffice/agent-skills`.
 * Type-only import of SkillContext / SkillDefinition / SkillPackage so the
 * published package doesn't drag in the entire @genoffice/agent-skills
 * source tree (which depends on @earendil-works/pi-coding-agent).
 */

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

export interface DocFormatOptions {
  /** Collapse multiple spaces into one. Default true. */
  collapseSpaces?: boolean
  /** Trim trailing whitespace on each line. Default true. */
  trimTrailing?: boolean
  /** Normalise CRLF / CR to LF. Default true. */
  normaliseLineEndings?: boolean
  /** Convert straight quotes to smart quotes. Default true. */
  smartQuotes?: boolean
  /** Maximum consecutive newlines (default 2). */
  maxBlankLines?: number
}

const DEFAULTS: Required<DocFormatOptions> = {
  collapseSpaces: true,
  trimTrailing: true,
  normaliseLineEndings: true,
  smartQuotes: true,
  maxBlankLines: 2,
}

/**
 * Convert straight quotes to smart quotes using a simple heuristic:
 *   - 'foo'  → 'foo' (curly single, both sides)
 *   - "foo"  → "foo" (curly double)
 * The opening/closing variants are picked by checking adjacency to whitespace.
 *
 * This is intentionally a minimal pass — production typography would consider
 * locale and word context, but for a skill-driven renderer-side use case the
 * heuristic is good enough.
 */
function smartify(input: string): string {
  // Double quotes: a " preceded by whitespace / start-of-string is opening,
  // otherwise closing.
  let out = ''
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') {
      const prev = i === 0 ? ' ' : input[i - 1]
      if (/\s/.test(prev) || prev === '(' || prev === '[') {
        out += '\u201C'
      } else {
        out += '\u201D'
      }
    } else if (ch === "'") {
      const prev = i === 0 ? ' ' : input[i - 1]
      if (/\s/.test(prev) || prev === '(' || prev === '[') {
        out += '\u2018'
      } else {
        out += '\u2019'
      }
    } else {
      out += ch
    }
  }
  return out
}

export interface DocFormatResult {
  text: string
  changed: boolean
  stats: {
    collapsedSpaces: number
    trimmedTrailing: number
    normalisedLineEndings: number
    smartQuoteConversions: number
    blankLinesCollapsed: number
  }
}

export function formatDoc(text: string, options: DocFormatOptions = {}): DocFormatResult {
  if (typeof text !== 'string') {
    throw new SkillError('INVALID_ARGUMENT', 'text must be a string')
  }
  const opts: Required<DocFormatOptions> = { ...DEFAULTS, ...options }

  const stats = {
    collapsedSpaces: 0,
    trimmedTrailing: 0,
    normalisedLineEndings: 0,
    smartQuoteConversions: 0,
    blankLinesCollapsed: 0,
  }

  let working = text

  if (opts.normaliseLineEndings) {
    const before = working
    working = working.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    stats.normalisedLineEndings = (before.match(/\r/g) ?? []).length
  }

  if (opts.trimTrailing) {
    const lines = working.split('\n')
    let trimmed = 0
    const out: string[] = []
    for (const line of lines) {
      const m = line.match(/^(.*?)([ \t]+)$/)
      if (m) {
        out.push(m[1])
        trimmed += m[2].length
      } else {
        out.push(line)
      }
    }
    stats.trimmedTrailing = trimmed
    working = out.join('\n')
  }

  if (opts.collapseSpaces) {
    const before = working
    working = working.replace(/[ \t]{2,}/g, ' ')
    stats.collapsedSpaces = before.length - working.length
  }

  if (opts.smartQuotes) {
    const before = working
    working = smartify(working)
    let delta = 0
    for (let i = 0; i < Math.min(before.length, working.length); i++) {
      if (before[i] !== working[i]) delta++
    }
    stats.smartQuoteConversions = delta
  }

  if (opts.maxBlankLines >= 1) {
    const re = new RegExp(`\\n{${opts.maxBlankLines + 1},}`, 'g')
    const before = working
    working = working.replace(re, '\n'.repeat(opts.maxBlankLines))
    stats.blankLinesCollapsed = before.length - working.length
  }

  return {
    text: working,
    changed: working !== text,
    stats,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill manifest
// ──────────────────────────────────────────────────────────────────────────────

const skill: SkillDefinition = {
  id: 'genoffice.skill.doc-format',
  version: '0.1.0',
  name: {
    'en-US': 'Format Document',
    'zh-CN': '文档排版',
  },
  description: {
    'en-US': 'Normalises whitespace, line endings, and quote characters in a plain-text document.',
    'zh-CN': '规范化纯文本文档中的空白、换行符和引号字符。',
  },
  triggers: ['format document', 'clean up document', '整理文档', '排版'],
  inputs: [
    {
      name: 'text',
      schema: { type: 'string', required: true, description: { 'en-US': 'Plain-text content', 'zh-CN': '纯文本内容' } } as never,
      required: true,
    },
    {
      name: 'options',
      schema: { type: 'object', properties: {} as Record<string, never>, required: false, description: { 'en-US': 'Format options', 'zh-CN': '排版选项' } } as never,
      required: false,
    },
  ],
  outputs: [
    { name: 'text', schema: { type: 'string' } },
    { name: 'changed', schema: { type: 'boolean' } },
    {
      name: 'stats',
      schema: {
        type: 'object',
        properties: {
          collapsedSpaces: { type: 'number' },
          trimmedTrailing: { type: 'number' },
          normalisedLineEndings: { type: 'number' },
          smartQuoteConversions: { type: 'number' },
          blankLinesCollapsed: { type: 'number' },
        },
      },
    },
  ],
  tags: ['document', 'format', 'typography'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.text !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'text must be a string')
    }
    const result = formatDoc(rawInputs.text, (rawInputs.options ?? {}) as DocFormatOptions)
    return { text: result.text, changed: result.changed, stats: result.stats }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }
