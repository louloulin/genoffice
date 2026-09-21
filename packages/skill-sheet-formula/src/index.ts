/**
 * @genoffice/skill-sheet-formula — a standalone Skill that parses an
 * Excel-style formula and produces a plain-English explanation plus a
 * structured breakdown.
 *
 * Scope (deliberately limited):
 *   - tokenise the formula into: identifiers, function calls, ranges, strings,
 *     numbers, operators, parens
 *   - resolve function names against a small built-in catalogue of common
 *     Excel functions (SUM, AVERAGE, IF, VLOOKUP, COUNTIF, …) and emit a
 *     description for each
 *   - detect common mistakes: mismatched parens, unknown functions, range
 *     strings that don't match the `A1`-style or `A1:B3`-style pattern,
 *     division by literal zero
 *
 * Not in scope (and intentionally so):
 *   - actually evaluating the formula — that's a spreadsheet engine's job
 *   - full Excel grammar — we cover the 90% case and gracefully fall back
 *     to "unparsed token" for anything we don't recognise
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

export type TokenKind =
  | 'function'
  | 'identifier'
  | 'range'
  | 'string'
  | 'number'
  | 'operator'
  | 'paren-open'
  | 'paren-close'
  | 'comma'
  | 'unknown'

export interface FormulaToken {
  kind: TokenKind
  value: string
  /** Position in the original input (0-based). */
  index: number
}

const FUNCTION_CATALOGUE: Record<string, string> = {
  SUM: 'Sum of values',
  AVERAGE: 'Arithmetic mean of values',
  COUNT: 'Count of numeric cells',
  COUNTA: 'Count of non-empty cells',
  COUNTIF: 'Count of cells matching a condition',
  COUNTIFS: 'Count of cells matching multiple conditions',
  IF: 'Conditional expression',
  IFS: 'Multi-branch conditional',
  VLOOKUP: 'Vertical lookup',
  HLOOKUP: 'Horizontal lookup',
  XLOOKUP: 'Modern lookup (Excel 365+)',
  INDEX: 'Return value at a position',
  MATCH: 'Find position of a value',
  CONCAT: 'Concatenate text (modern)',
  CONCATENATE: 'Concatenate text (legacy)',
  LEFT: 'Leftmost characters',
  RIGHT: 'Rightmost characters',
  MID: 'Middle characters',
  LEN: 'Length of text',
  TRIM: 'Remove extra spaces',
  UPPER: 'Convert to uppercase',
  LOWER: 'Convert to lowercase',
  ROUND: 'Round to N decimals',
  INT: 'Integer part',
  MOD: 'Modulo',
  ABS: 'Absolute value',
  MAX: 'Largest value',
  MIN: 'Smallest value',
  TODAY: "Today's date",
  NOW: 'Current date and time',
}

const CELL_REF_RE = /^\$?[A-Z]+\$?\d+$/
const RANGE_RE = /^\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+$/

/**
 * Tokenise an Excel-style formula. Returns a flat array of tokens plus the
 * last index where parsing stopped (so callers can report partial-success).
 */
export function tokenise(formula: string): FormulaToken[] {
  const tokens: FormulaToken[] = []
  let i = 0
  while (i < formula.length) {
    const ch = formula[i]
    // Whitespace
    if (/\s/.test(ch)) {
      i++
      continue
    }
    // String literal "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = ch
      let j = i + 1
      while (j < formula.length && formula[j] !== quote) j++
      tokens.push({ kind: 'string', value: formula.slice(i, j + 1), index: i })
      i = j + 1
      continue
    }
    // Number (with optional decimal and exponent)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(formula[i + 1] ?? ''))) {
      let j = i
      while (j < formula.length && /[0-9.]/.test(formula[j])) j++
      if (formula[j] === 'e' || formula[j] === 'E') {
        j++
        if (formula[j] === '+' || formula[j] === '-') j++
        while (j < formula.length && /[0-9]/.test(formula[j])) j++
      }
      tokens.push({ kind: 'number', value: formula.slice(i, j), index: i })
      i = j
      continue
    }
    // Identifier — could be a function (followed by `(`) or a cell ref / range
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < formula.length && /[A-Za-z0-9_$.]/.test(formula[j])) j++
      const word = formula.slice(i, j)
      // Range detection: word:word (no spaces)
      if (formula[j] === ':' && /[A-Za-z_]/.test(formula[j + 1] ?? '')) {
        let k = j + 1
        while (k < formula.length && /[A-Za-z0-9_$.]/.test(formula[k])) k++
        const range = formula.slice(i, k)
        tokens.push({ kind: 'range', value: range, index: i })
        i = k
        continue
      }
      // Function if followed by '('
      if (formula[j] === '(') {
        tokens.push({ kind: 'function', value: word.toUpperCase(), index: i })
        i = j
        continue
      }
      // Cell reference?
      if (CELL_REF_RE.test(word) || word.includes('.')) {
        tokens.push({ kind: 'identifier', value: word, index: i })
        i = j
        continue
      }
      // Plain identifier (e.g. named range).
      tokens.push({ kind: 'identifier', value: word, index: i })
      i = j
      continue
    }
    // Range starting with cell ref followed by `:` — but not caught above because
    // the second half also matches identifier chars. Handled in the identifier
    // branch above.
    // Operators / punctuation
    if (ch === '(') {
      tokens.push({ kind: 'paren-open', value: ch, index: i })
      i++
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'paren-close', value: ch, index: i })
      i++
      continue
    }
    if (ch === ',') {
      tokens.push({ kind: 'comma', value: ch, index: i })
      i++
      continue
    }
    if (/[+\-*/^&=<>!%]/.test(ch)) {
      // Multi-char operators: <= >= <> !=
      let j = i + 1
      if ((ch === '<' || ch === '>' || ch === '!') && formula[j] === '=') j++
      else if (ch === '<' && formula[j] === '>') j++
      tokens.push({ kind: 'operator', value: formula.slice(i, j), index: i })
      i = j
      continue
    }
    // Unknown character — emit a token and keep going.
    tokens.push({ kind: 'unknown', value: ch, index: i })
    i++
  }
  return tokens
}

export interface FormulaIssue {
  /** Severity — `error` is a hard parse failure, `warning` is a heuristic. */
  severity: 'error' | 'warning'
  message: string
  /** Position in the original formula. */
  index?: number
}

export interface FormulaExplanation {
  /** Plain-English description of what the formula does (best effort). */
  summary: string
  /** Function calls encountered, in order. */
  functions: Array<{ name: string; description: string }>
  /** Cell references / ranges mentioned, deduplicated. */
  references: string[]
  /** Issues found during parsing. */
  issues: FormulaIssue[]
}

export function explainFormula(formula: string): FormulaExplanation {
  if (typeof formula !== 'string') {
    throw new SkillError('INVALID_ARGUMENT', 'formula must be a string')
  }
  const trimmed = formula.trim()
  if (trimmed.length === 0) {
    return { summary: 'Empty formula.', functions: [], references: [], issues: [] }
  }
  // Excel formulas conventionally start with `=`. Strip it for parsing.
  const body = trimmed.startsWith('=') ? trimmed.slice(1) : trimmed
  const tokens = tokenise(body)

  const issues: FormulaIssue[] = []
  const references = new Set<string>()
  const functions: Array<{ name: string; description: string }> = []

  // Paren balance check
  let open = 0
  for (const t of tokens) {
    if (t.kind === 'paren-open') open++
    else if (t.kind === 'paren-close') open--
    if (open < 0) {
      issues.push({ severity: 'error', message: 'unmatched closing parenthesis', index: t.index })
      open = 0
    }
  }
  if (open > 0) {
    issues.push({ severity: 'error', message: `${open} unmatched opening parenthesis` })
  }

  // Collect references and functions; detect mistakes.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'function') {
      const desc = FUNCTION_CATALOGUE[t.value]
      if (desc) {
        functions.push({ name: t.value, description: desc })
      } else {
        issues.push({ severity: 'warning', message: `unknown function ${t.value}`, index: t.index })
      }
      // Function must be followed by an opening paren — if we tokenised
      // FUNCTION, the `(` already appears as a separate token.
      const next = tokens[i + 1]
      if (!next || next.kind !== 'paren-open') {
        issues.push({ severity: 'error', message: `function ${t.value} missing argument list`, index: t.index })
      }
    }
    if (t.kind === 'range') {
      if (!RANGE_RE.test(t.value)) {
        issues.push({ severity: 'warning', message: `range "${t.value}" not in A1:B3 form`, index: t.index })
      }
      references.add(t.value)
    }
    if (t.kind === 'identifier' && CELL_REF_RE.test(t.value)) {
      references.add(t.value)
    }
  }

  // Look for division by literal zero — `/0` or `/0.0`.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].kind === 'operator' && tokens[i].value === '/' && tokens[i + 1].kind === 'number') {
      const n = Number(tokens[i + 1].value)
      if (n === 0) {
        issues.push({ severity: 'warning', message: 'division by literal zero', index: tokens[i + 1].index })
      }
    }
  }

  // Build a one-line summary.
  let summary: string
  if (functions.length === 0 && references.size === 0) {
    summary = 'A literal expression with no function calls or cell references.'
  } else if (functions.length === 1) {
    const f = functions[0]
    const refs = [...references]
    summary = `Calls ${f.name} (${f.description})${refs.length ? ` over ${refs.join(', ')}` : ''}.`
  } else {
    summary = `Combines ${functions.length} function calls (${functions.map((f) => f.name).join(', ')}) and ${references.size} cell reference(s).`
  }

  return {
    summary,
    functions,
    references: [...references].sort(),
    issues,
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Skill manifest
// ──────────────────────────────────────────────────────────────────────────────

const skill: SkillDefinition = {
  id: 'genoffice.skill.sheet-formula',
  version: '0.1.0',
  name: {
    'en-US': 'Explain Sheet Formula',
    'zh-CN': '解释表格公式',
  },
  description: {
    'en-US': 'Tokenises an Excel-style formula and returns a plain-English explanation plus a list of issues.',
    'zh-CN': '解析 Excel 风格公式，返回自然语言解释与潜在问题列表。',
  },
  triggers: ['explain formula', 'check formula', '解释公式', '校验公式'],
  inputs: [
    {
      name: 'formula',
      schema: { type: 'string', required: true, description: { 'en-US': 'Formula text (with or without leading =)', 'zh-CN': '公式文本（可选是否带前导 =）' } } as never,
      required: true,
    },
  ],
  outputs: [
    { name: 'summary', schema: { type: 'string' } },
    {
      name: 'functions',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    { name: 'references', schema: { type: 'array', items: { type: 'string' } } },
    {
      name: 'issues',
      schema: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string' },
            message: { type: 'string' },
            index: { type: 'number' },
          },
        },
      },
    },
  ],
  tags: ['sheets', 'formula', 'explain'],
  execute: async (_ctx: SkillContext, rawInputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (typeof rawInputs.formula !== 'string') {
      throw new SkillError('INVALID_ARGUMENT', 'formula must be a string')
    }
    const r = explainFormula(rawInputs.formula)
    return { summary: r.summary, functions: r.functions, references: r.references, issues: r.issues }
  },
}

const pkg: SkillPackage = { skill }

export default pkg
export { pkg, skill }
