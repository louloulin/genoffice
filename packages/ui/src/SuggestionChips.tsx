/**
 * Follow-up suggestion chips.
 *
 * Rendered under an assistant message. The host decides what to put in —
 * a static set ("Summarize", "Translate", "Explain") plus, optionally,
 * context-aware entries the runtime derives from the answer.
 *
 * Click semantics: the chip calls `onPick(suggestion)`. The host typically
 *   1. inserts the suggestion's prompt into the composer, or
 *   2. fires the suggestion immediately (e.g. when it owns no composer).
 *
 * Kept tiny on purpose: the chips are visually small, scroll horizontally,
 * and disappear while a run is in flight so the user is not tempted to
 * stack requests.
 */
import React from 'react'

/** A single suggestion. Pure data so the chip is app-agnostic. */
export interface Suggestion {
  readonly id: string
  /** Visible label on the chip. */
  readonly label: string
  /** Optional prompt text. When omitted, `label` is used verbatim. */
  readonly prompt?: string
  /** Tooltip / hover detail — usually the full prompt. */
  readonly title?: string
  /** Disabled rows still render but do not fire. */
  readonly disabled?: boolean
}

export interface SuggestionChipsProps {
  readonly suggestions: readonly Suggestion[]
  readonly onPick: (suggestion: Suggestion) => void
  /** Accessible label for the row. */
  readonly ariaLabel?: string
}

export function SuggestionChips({
  suggestions,
  onPick,
  ariaLabel,
}: SuggestionChipsProps): React.JSX.Element | null {
  if (suggestions.length === 0) return null
  return (
    <div className="ai-suggestion-chips" role="toolbar" aria-label={ariaLabel}>
      {suggestions.map((s) => (
        <button
          key={s.id}
          type="button"
          className="ai-suggestion-chip"
          title={s.title ?? s.label}
          aria-label={s.title ?? s.label}
          disabled={s.disabled}
          onClick={() => {
            if (s.disabled) return
            onPick(s)
          }}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}
