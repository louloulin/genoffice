/**
 * useEditLast — restore the most recent user message into the composer.
 *
 * Workbuddy / ChatGPT pattern: when the textarea is empty, ArrowUp loads
 * the last user message so the user can edit-and-resend instead of
 * scrolling up the history.
 *
 * Returns a single `restoreLast` callback the host hands to `AiComposer`'s
 * `onEditLast` prop. The host owns the chat state — this hook only walks
 * the list backwards to find the first entry with `role === 'user'` and a
 * non-empty `text`.
 *
 * Shape is intentionally minimal: any object with `{ role: 'user' | ...;
 * text: string }` works, so the hook does not need to know about the
 * runtime-specific ChatMessage type.
 */
import { useCallback } from 'react'

export interface EditLastEntry {
  readonly role: 'user' | 'assistant' | 'system' | string
  readonly text: string
}

export interface UseEditLastOptions<E extends EditLastEntry> {
  /** The current message list, oldest first. */
  readonly entries: readonly E[]
  /** Set the composer's value (typically the same setter the textarea uses). */
  readonly setValue: (next: string) => void
  /** Focus the textarea — usually `textareaRef.current?.focus()`. */
  readonly focus?: () => void
}

export interface UseEditLastReturn {
  readonly restoreLast: () => void
}

/** Pure helper exported separately for testing. */
export function findLastUserText<E extends EditLastEntry>(entries: readonly E[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e) continue
    if (e.role !== 'user') continue
    if (typeof e.text !== 'string') continue
    if (e.text.length === 0) continue
    return e.text
  }
  return null
}

export function useEditLast<E extends EditLastEntry>(
  options: UseEditLastOptions<E>,
): UseEditLastReturn {
  const { entries, setValue, focus } = options
  const restoreLast = useCallback((): void => {
    const text = findLastUserText(entries)
    if (text === null) return
    setValue(text)
    focus?.()
  }, [entries, setValue, focus])
  return { restoreLast }
}
