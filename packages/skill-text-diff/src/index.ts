/**
 * @genoffice/skill-text-diff — a standalone Skill that computes a
 * unified-diff style change list between two plain-text inputs.
 *
 * Algorithm: classic Myers LCS via dynamic programming. O(n*m) time and
 * space — fine for the kind of inputs a skill is asked to handle (paragraphs
 * to a few pages). Returns a list of hunks rather than the full diff
 * string so callers can decide how to render.
 *
 * Each hunk represents a contiguous change region with N context lines on
 * each side (default 3).
 *
 * Type-only import of SkillContext / SkillDefinition / SkillPackage.
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

export type DiffOp = 'equal' | 'insert' | 'delete'

export interface DiffLine {
  op: DiffOp
  text: string
  /** 0-based line index in the OLD (left) input. `null` for inserted lines. */
  oldIndex: number | null
  /** 0-based line index in the NEW (right) input. `null` for deleted lines. */
  newIndex: number | null
}

export interface DiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffOptions {
  /** Number of unchanged lines to keep around each change. Default 3. */
  context?: number
}

const DEFAULTS: Required<DiffOptions> = { context: 3 }

/**
 * Compute the line-level LCS table.
 * `lcs[i][j]` = length of the longest common subsequence between old[0..i] and new[0..j].
 */
function buildLcs(old: string[], next: string[]): number[][] {
  const m = old.length
  const n = next.length
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (old[i - 1] === next[j - 1]) {
        lcs[i][j] = lcs[i - 1][j - 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i - 1][j], lcs[i][j - 1])
      }
    }
  }
  return lcs
}

/**
 * Walk the LCS table to recover the edit script.
 */
function recoverEdits(old: string[], next: string[], lcs: number[][]): DiffLine[] {
  const ops: DiffLine[] = []
  let i = old.length
  let j = next.length
  while (i > 0 && j > 0) {
    if (old[i - 1] === next[j - 1]) {
      ops.push({ op: 'equal', text: old[i - 1], oldIndex: i - 1, newIndex: j - 1 })
      i--
      j--
    } else if (lcs[i - 1][j] >= lcs[i][j - 1]) {
      ops.push({ op: 'delete', text: old[i - 1], oldIndex: i - 1, newIndex: null })
      i--
    } else {
      ops.push({ op: 'insert', text: next[j - 1], oldIndex: null, newIndex: j - 1 })
      j--
    }
  }
  while (i > 0) {
    ops.push({ op: 'delete', text: old[i - 1], oldIndex: i - 1, newIndex: null })
    i--
  }
  while (j > 0) {
    ops.push({ op: 'insert', text: next[j - 1], oldIndex: null, newIndex: j - 1 })
    j--
  }
  return ops.reverse()
}

/**
 * Group the edit script into hunks separated by runs of unchanged lines.
 */
function groupHunks(ops: DiffLine[], context: number): DiffHunk[] {
  const hunks: DiffHunk[] = []

  // First pass: locate every contiguous change region (non-equal runs).
  type Region = { start: number; end: number }
  const regions: Region[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].op === 'equal') {
      i++
      continue
    }
    const regionStart = i
    while (i < ops.length && ops[i].op !== 'equal') i++
    regions.push({ start: regionStart, end: i }) // end is exclusive
  }

  if (regions.length === 0) return hunks

  // Second pass: each change region gets its own hunk with up to `context`
  // equal lines BEFORE (bounded by the previous change region) and up to
  // `context` equal lines AFTER (bounded by the next change region).
  for (let r = 0; r < regions.length; r++) {
    const region = regions[r]
    let start = region.start
    let end = region.end // exclusive

    // Walk back to include up to `context` equal lines, stopping at the
    // previous change region (if any).
    let backCount = 0
    while (start > 0 && ops[start - 1].op === 'equal' && backCount < context) {
      start--
      backCount++
    }
    if (r > 0) {
      const prevEnd = regions[r - 1].end
      if (start < prevEnd) start = prevEnd
    }

    // Walk forward to include up to `context` equal lines, stopping at the
    // next change region (if any).
    let forwardCount = 0
    while (end < ops.length && ops[end].op === 'equal' && forwardCount < context) {
      end++
      forwardCount++
    }
    if (r < regions.length - 1) {
      const nextStart = regions[r + 1].start
      if (end > nextStart) end = nextStart
    }

    const slice = ops.slice(start, end)
    let oldStart = 0
    let newStart = 0
    let oldCount = 0
    let newCount = 0
    let oldStartSet = false
    let newStartSet = false
    for (const line of slice) {
      if (line.oldIndex !== null) {
        oldCount++
        if (!oldStartSet) {
          oldStart = line.oldIndex
          oldStartSet = true
        }
      }
      if (line.newIndex !== null) {
        newCount++
        if (!newStartSet) {
          newStart = line.newIndex
          newStartSet = true
        }
      }
    }
    hunks.push({
      oldStart: oldStart + 1, // unified-diff uses 1-based
      oldLines: oldCount,
      newStart: newStart + 1,
      newLines: newCount,
      lines: slice,
    })
  }
  return hunks
}

export function diffText(oldText: string, newText: string, options: DiffOptions = {}): DiffHunk[] {
  if (typeof oldText !== 'string' || typeof newText !== 'string') {
    throw new SkillError('INVALID_ARGUMENT', 'oldText and newText must both be strings')
  }
  const opts: Required<DiffOptions> = { ...DEFAULTS, ...options }
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const lcs = buildLcs(oldLines, newLines)
  const ops = recoverEdits(oldLines, newLines, lcs)
  return groupHunks(ops, opts.context)
}

/** Convenience: render hunks as a unified-diff string. */
export function renderUnified(hunks: DiffHunk[]): string {
  const out: string[] = []
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    for (const line of h.lines) {
      const prefix = line.op === 'insert' ? '+' : line.op === 'delete' ? '-' : ' '
      out.push(prefix + line.text)
    }
  }
  return out.join('\n')
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill manifest
// ──────────────────────────────────────────────────────────────────────────────

const skill: SkillDefinition = {
  id: 'genoffice.skill.text-diff',
  version: '0.1.0',
  name: {
    'en-US': 'Diff Two Texts',
    'zh-CN': '文本对比',
  },
  description: {
    'en-US': 'Computes a unified-diff style change list between two plain-text inputs.',
    'zh-CN': '计算两段纯文本之间的 unified-diff 风格差异列表。',
  },
  triggers: ['diff text', 'compare text', '文本对比', '比较文本'],
  inputs: [
    {
      name: 'oldText',
      schema: { type: 'string', required: true, description: { 'en-US': 'Old text', 'zh-CN': '原文' } } as never,
      required: true,
    },
    {
      name: 'newText',
      schema: { type: 'string', required: true, description: { 'en-US': 'New text', 'zh-CN': '新文' } } as never,
      required: true,
    },
    {
      name: 'options',
      schema: { type: 'object', properties: {} as Record<string, never>, required: false } as never,
      required: false,
    },
  ],
  outputs: [
    {
      name: 'hunks',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            oldStart: { type: 'number' },
            oldLines: { type: 'number' },
            newStart: { type: 'number' },
            newLines: { type: 'number' },
            lines: { type: 'array', items: { type: 'object', properties: {} as Record<string, never> } },
          },
        },
      },
    },
    { name: 'unified', schema: { type: 'string' } },
  ],
  tags: ['diff', 'text', 'patch'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.oldText !== 'string' || typeof rawInputs.newText !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'oldText and newText must both be strings')
    }
    const hunks = diffText(rawInputs.oldText, rawInputs.newText, (rawInputs.options ?? {}) as DiffOptions)
    return { hunks, unified: renderUnified(hunks) }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }
