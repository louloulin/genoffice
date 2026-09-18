/**
 * Token counter for the composer footer.
 *
 * Cursor pattern: a compact "1.2k / 8k" badge + thin progress bar that
 * shifts green → amber → red as the prompt approaches the model's
 * context window.
 *
 * Estimates the input length in tokens without calling the model:
 *   - 1 token ≈ 4 chars for Latin/CJK-blended text (the canonical OpenAI
 *     rule of thumb)
 *   - CJK characters are denser; we treat each CJK char as ~1 token, which
 *     matches tiktoken's BPE for CJK more closely than 4-chars-per-token
 *
 * The threshold colors are app-overridable; the defaults are tuned for the
 * typical 8k prompt budget:
 *   - < 60%  green / neutral
 *   - 60-85% warn (amber)
 *   - ≥ 85%  danger (red)
 */
export type CounterTone = 'idle' | 'warn' | 'danger'

export interface TokenCounterOptions {
  /** Hard cap shown in the footer (e.g. the model's context window). */
  readonly budget: number
  /** Warn threshold as a fraction of the budget. Default 0.6. */
  readonly warnAt?: number
  /** Danger threshold as a fraction of the budget. Default 0.85. */
  readonly dangerAt?: number
}

export interface TokenCounter {
  /** Raw char count, the most familiar unit for users. */
  readonly chars: number
  /** Estimated tokens for the prompt. */
  readonly tokens: number
  /** Fraction of the budget consumed (0–1). */
  readonly ratio: number
  /** Tone drives the footer's color class. */
  readonly tone: CounterTone
  /** Compact "1.2k / 8k" string. */
  readonly label: string
}

/**
 * Estimate tokens for a single string. Blends the 4-chars-per-token
 * rule for ASCII with a 1-token-per-CJK-char adjustment; the result is
 * good enough for a UI badge.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let ascii = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat Ideographs
      (code >= 0xff00 && code <= 0xffef) // half/full-width forms
    ) {
      cjk++
    } else {
      ascii++
    }
  }
  // Each CJK char ≈ 1 token (BPE groups them in pairs sometimes, but the
  // boundary case is rare enough that the bias is on the safe side).
  // ASCII chunks: 4 chars per token is the canonical rule.
  return Math.ceil(cjk + ascii / 4)
}

function formatTokens(n: number): string {
  if (n >= 10000) return `${Math.round(n / 100) / 10}k`
  if (n >= 1000) return `${(Math.round(n / 100) / 10).toFixed(1)}k`
  return String(n)
}

/** Pure helper — works without React. The composer's footer just calls this. */
export function computeTokenCounter(
  text: string,
  options: TokenCounterOptions,
): TokenCounter {
  const { budget, warnAt = 0.6, dangerAt = 0.85 } = options
  const chars = text.length
  const tokens = estimateTokens(text)
  const ratio = budget > 0 ? tokens / budget : 0
  const tone: CounterTone = ratio >= dangerAt ? 'danger' : ratio >= warnAt ? 'warn' : 'idle'
  const label = `${formatTokens(tokens)} / ${formatTokens(budget)}`
  return { chars, tokens, ratio, tone, label }
}
