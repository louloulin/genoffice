import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconEnter, IconMic, IconSend, IconStop } from './icons'
import { useAiPanelPrefs } from './ai-panel-prefs-store'
import { AiComposerMenu } from './AiComposerMenu'
import { AiMentionMenu } from './AiMentionMenu'
import {
  activeSlashQuery,
  applyComposerCommand,
  filterComposerCommands,
  firstEnabledIndex,
  flattenComposerGroups,
  groupComposerCommands,
  nextEnabledIndex,
} from './chat/composer-commands'
import type { ComposerCommand, SlashQuery } from './chat/composer-commands'
import {
  activeMentionQuery,
  applyMentionPick,
  filterMentionEntries,
  flattenMentionGroups,
  nextEnabledMentionIndex,
  type MentionEntry,
  type MentionPick,
  type MentionQuery,
} from './chat/mentions'
import { computeTokenCounter, type TokenCounter } from './chat/token-counter'
import type { ChatMode } from './chat/modes'

// Keep in sync with the CSS `max-height` on `.ai-input-box textarea` (7 lines à 24px)
const MAX_TEXTAREA_HEIGHT = 168

/**
 * One entry of the mode switch. The label/title are supplied by the app
 * (usually from its i18n bundle) because this shared component never
 * hard-codes user-facing copy.
 */
export interface ComposerModeOption {
  readonly id: ChatMode
  readonly label: string
  /** hover text — usually the mode's one-line description */
  readonly title?: string | undefined
}

/** What the composer hands back when the user picks a `/command`. */
export interface ComposerCommandPick {
  readonly command: ComposerCommand
  /** Text the textarea should hold after the pick (the `/query` already removed). */
  readonly value: string
  /** Caret offset to restore once the value lands. */
  readonly caret: number
  /** The text that was typed after `/`. */
  readonly query: string
}

/** Voice input descriptor — kept inline so each app can plug its own recogniser. */
export interface ComposerVoice {
  readonly available: boolean | undefined
  readonly active: boolean | undefined
  readonly label: string
  readonly onStart: () => void
  readonly onStop: () => void
}

/**
 * The AI panel input box shared by every app: auto-growing textarea
 * (Enter sends, Shift+Enter newline, Esc stops) plus a footer with optional
 * app-specific controls, a shortcut hint, and the send/stop button.
 * Renders the `.ai-input-box` class family; each app themes it in its own CSS.
 *
 * Optional extras are additive — with none of them passed the markup is
 * unchanged:
 *
 *  - `commands` / `onCommandPick`: typing `/` opens a grouped palette of
 *    app-supplied actions, skills and templates.
 *  - `mentions` / `onMentionPick`: typing `@` opens a Cursor-style picker
 *    of files / blocks / skills / agents.
 *  - `modes` / `mode` / `onModeChange`: Ask / Craft / Plan switch.
 *  - `toolbar` / `leading`: slots for app chrome.
 *  - `voice`: Web Speech API mic button.
 *  - `onEditLast`: ArrowUp-on-empty restores the previous user turn.
 *  - `tokenBudget`: render a Cursor-style "1.2k / 8k" counter + bar in the footer.
 *  - `slashTriggerLabel` / `slashTriggerTitle`: visible `/` chip shown when
 *    the field is empty, teaching the palette exists without forcing typing.
 */
export function AiComposer({
  value,
  busy,
  placeholder,
  hintIdle,
  hintBusy,
  hintIdleTitle,
  sendLabel,
  stopLabel,
  ariaLabel,
  header,
  footerStart,
  iconOnly = false,
  sendIconEnabled,
  sendIconDisabled,
  stopIcon,
  textareaRef,
  onChange,
  onSend,
  onStop,
  onPasteFiles,
  onPasteText,
  commands,
  onCommandPick,
  commandMenuLabel = 'Commands',
  commandMenuEmptyLabel = 'No matching command',
  commandMenuFootHint,
  mentions,
  onMentionPick,
  mentionMenuLabel = 'Mentions',
  mentionMenuEmptyLabel = 'No matching reference',
  mentionMenuFootHint,
  modes,
  mode,
  onModeChange,
  modeSwitchLabel,
  toolbar,
  leading,
  voice,
  onEditLast,
  tokenBudget,
  slashTriggerLabel = '/',
  slashTriggerTitle,
}: {
  readonly value: string
  readonly busy: boolean
  readonly placeholder: string
  readonly hintIdle: string
  readonly hintBusy: string
  readonly hintIdleTitle?: string | undefined
  readonly sendLabel: string
  readonly stopLabel: string
  readonly ariaLabel?: string | undefined
  /** content inside the box above the textarea (attachment chips, …) — Genspark composer style */
  readonly header?: React.ReactNode
  /** extra controls at the left of the footer (attach button, toggles, …) */
  readonly footerStart?: React.ReactNode
  /** compact variant: no hint text, icon-only enter/stop button (Genspark composer style) */
  readonly iconOnly?: boolean | undefined
  readonly sendIconEnabled?: React.ReactNode
  readonly sendIconDisabled?: React.ReactNode
  readonly stopIcon?: React.ReactNode
  readonly textareaRef?: React.RefObject<HTMLTextAreaElement | null> | undefined
  readonly onChange: (next: string) => void
  readonly onSend: () => void
  readonly onStop: () => void
  readonly onPasteFiles?: ((files: File[]) => void) | undefined
  readonly onPasteText?: ((text: string) => boolean) | undefined
  readonly commands?: readonly ComposerCommand[] | undefined
  readonly onCommandPick?: ((pick: ComposerCommandPick) => void) | undefined
  readonly commandMenuLabel?: string | undefined
  readonly commandMenuEmptyLabel?: string | undefined
  readonly commandMenuFootHint?: string | undefined
  /** @-mention table; omit to disable the picker */
  readonly mentions?: readonly MentionEntry[] | undefined
  readonly onMentionPick?: ((pick: MentionPick) => void) | undefined
  readonly mentionMenuLabel?: string | undefined
  readonly mentionMenuEmptyLabel?: string | undefined
  readonly mentionMenuFootHint?: string | undefined
  readonly modes?: readonly ComposerModeOption[] | undefined
  readonly mode?: ChatMode | undefined
  readonly onModeChange?: ((mode: ChatMode) => void) | undefined
  readonly modeSwitchLabel?: string | undefined
  /** Voice input — the host owns the recogniser, the composer only renders the mic. */
  readonly voice?: ComposerVoice | undefined
  readonly onEditLast?: (() => void) | undefined
  readonly toolbar?: React.ReactNode
  readonly leading?: React.ReactNode
  /**
   * Optional token-budget badge shown in the footer. When provided, the
   * composer renders the counter + progress bar after `toolbar`.
   */
  readonly tokenBudget?: number | undefined
  /** Visible label on the slash trigger chip. Default `/`. */
  readonly slashTriggerLabel?: string | undefined
  /** Hover text for the slash trigger chip. */
  readonly slashTriggerTitle?: string | undefined
}): React.JSX.Element {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const ref = textareaRef ?? innerRef
  const canSend = value.trim().length > 0 && !busy
  const { spellcheck } = useAiPanelPrefs()

  // ─────────────── slash palette state ───────────────
  const [slash, setSlash] = useState<SlashQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Esc hides the palette for the *current* `/query` only: editing the query
  // clears this, so Esc never feels sticky.
  const [dismissed, setDismissed] = useState<string | null>(null)

  // ─────────────── mention palette state ───────────────
  const [mention, setMention] = useState<MentionQuery | null>(null)
  const [mentionDismissed, setMentionDismissed] = useState<string | null>(null)
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0)

  // The slash trigger chip forces the palette open even with an empty field
  // (Cursor / workbuddy pattern). Tracked separately so the empty-query
  // dismiss rule doesn't kick in.
  const [slashTriggerOpen, setSlashTriggerOpen] = useState(false)

  const menuId = React.useId()

  const ranked = useMemo(
    () =>
      slash !== null && commands && commands.length > 0
        ? filterComposerCommands(commands, slash.query)
        : [],
    [slash, commands],
  )
  const groups = useMemo(() => groupComposerCommands(ranked, ''), [ranked])
  const rows = useMemo(() => flattenComposerGroups(groups), [groups])

  const rankedMentions = useMemo(
    () =>
      mention !== null && mentions && mentions.length > 0
        ? filterMentionEntries(mentions, mention.query)
        : { query: '', groups: [], firstEnabledIndex: 0 },
    [mention, mentions],
  )
  const mentionRows = useMemo(() => flattenMentionGroups(rankedMentions.groups), [rankedMentions])

  // Slash palette opens for any valid `/query`; trigger chip keeps it open
  // for an empty query as well.
  const open = slash !== null && dismissed !== slash.query
  const mentionOpen = mention !== null && mentionDismissed !== mention.query

  // Keep the highlight on a pickable row and reset it whenever the query
  // changes, without a second render pass (derived state, not an effect).
  const queryKey = slash === null ? null : slash.query
  const [lastQuery, setLastQuery] = useState<string | null>(null)
  if (lastQuery !== queryKey) {
    setLastQuery(queryKey)
    setActiveIndex(firstEnabledIndex(rows))
  } else if (rows.length > 0 && (activeIndex < 0 || rows[activeIndex]?.disabled === true)) {
    setActiveIndex(firstEnabledIndex(rows))
  }
  const mentionKey = mention === null ? null : mention.query
  const [lastMentionKey, setLastMentionKey] = useState<string | null>(null)
  if (lastMentionKey !== mentionKey) {
    setLastMentionKey(mentionKey)
    setMentionActiveIndex(rankedMentions.firstEnabledIndex ?? 0)
  } else if (
    mentionRows.length > 0 &&
    (mentionActiveIndex < 0 || mentionRows[mentionActiveIndex]?.disabled === true)
  ) {
    setMentionActiveIndex(rankedMentions.firstEnabledIndex ?? 0)
  }

  // auto-grow up to ~6 lines; empty clears the inline height outright so the
  // CSS min-height governs (a hidden-at-measure pass can leave a stale value).
  useEffect(() => {
    const ta = ref.current
    if (!ta) return
    if (value === '') {
      ta.style.height = ''
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [value, ref])

  // ─────────────── token counter (derived, no state) ───────────────
  const counter: TokenCounter | null = useMemo(() => {
    if (tokenBudget === undefined || tokenBudget === null) return null
    return computeTokenCounter(value, { budget: tokenBudget })
  }, [value, tokenBudget])

  // Click the slash trigger chip → focus textarea, open palette, keep field empty.
  const openSlashFromTrigger = useCallback(() => {
    const ta = ref.current
    if (!ta) return
    ta.focus()
    // Synthesise a one-character `/query` so the palette state machine
    // opens with the empty-query state. Inserting the slash into the value
    // is the host's choice — they may want a leading slash with text, or
    // a pure palette open.
    const next = `${value}${value.endsWith(' ') || value === '' ? '' : ' '}/`
    onChange(next)
    setSlashTriggerOpen(true)
    requestAnimationFrame(() => {
      const caret = next.length
      setSlash(activeSlashQuery(next, caret))
      setDismissed(null)
      ta.setSelectionRange(caret, caret)
    })
  }, [value, onChange, ref])

  const syncPalettes = useCallback((next: string, caret: number) => {
    const foundSlash = activeSlashQuery(next, caret)
    setSlash(foundSlash)
    setDismissed((d) => (foundSlash !== null && d !== null && d !== foundSlash.query ? null : d))
    const foundMention = activeMentionQuery(next, caret)
    setMention(foundMention)
    setMentionDismissed((d) =>
      foundMention !== null && d !== null && d !== foundMention.query ? null : d,
    )
    // The slash-trigger chip forces an empty palette only while the field
    // is exactly `/`; once the user types more characters it becomes a
    // normal slash query.
    if (slashTriggerOpen) {
      if (foundSlash === null || foundSlash.query !== '') setSlashTriggerOpen(false)
    }
  }, [slashTriggerOpen])

  const pickCommand = useCallback(
    (cmd: ComposerCommand) => {
      if (cmd.disabled || slash === null) return
      const applied = applyComposerCommand(value, slash, cmd)
      setSlash(null)
      setDismissed(null)
      setSlashTriggerOpen(false)
      setActiveIndex(0)
      onChange(applied.value)
      onCommandPick?.({
        command: cmd,
        value: applied.value,
        caret: applied.caret,
        query: slash.query,
      })
      requestAnimationFrame(() => {
        const ta = ref.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(applied.caret, applied.caret)
      })
    },
    [slash, value, onChange, onCommandPick, ref],
  )

  const pickMention = useCallback(
    (entry: MentionEntry) => {
      if (entry.disabled || mention === null) return
      const applied = applyMentionPick(value, mention, entry)
      setMention(null)
      setMentionDismissed(null)
      setMentionActiveIndex(0)
      onChange(applied.value)
      onMentionPick?.({
        entry,
        insert: applied.value.slice(mention.start, applied.caret),
        value: applied.value,
        caret: applied.caret,
        query: mention.query,
      })
      requestAnimationFrame(() => {
        const ta = ref.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(applied.caret, applied.caret)
      })
    },
    [mention, value, onChange, onMentionPick, ref],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return

    // Mention palette has priority over slash — they're never open at once
    // (typing `@` after a `/query` closes the slash because the `@` is
    // non-whitespace mid-`/query`).
    if (mentionOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionActiveIndex((i) =>
          nextEnabledMentionIndex(mentionRows, i < 0 ? -1 : i, e.key === 'ArrowDown' ? 1 : -1),
        )
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const entry = mentionRows[mentionActiveIndex]
        if (entry && !entry.disabled) {
          e.preventDefault()
          pickMention(entry)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionDismissed(mention?.query ?? '')
        return
      }
    }

    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) =>
          nextEnabledIndex(rows, i < 0 ? -1 : i, e.key === 'ArrowDown' ? 1 : -1),
        )
        return
      }
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        setActiveIndex(e.key === 'Home' ? firstEnabledIndex(rows) : nextEnabledIndex(rows, -1, -1))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const cmd = rows[activeIndex]
        if (cmd && !cmd.disabled) {
          e.preventDefault()
          pickCommand(cmd)
          return
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(slash?.query ?? '')
        return
      }
    }
    if (e.key === 'ArrowUp' && !e.shiftKey && value === '') {
      // chat-style "edit last" — only when the textarea is empty so the user
      // does not lose what they typed; the host wires the history loader.
      if (onEditLast) {
        e.preventDefault()
        onEditLast()
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (canSend) onSend()
    } else if (e.key === 'Escape' && busy) {
      e.preventDefault()
      onStop()
    }
  }

  const showModes = (modes?.length ?? 0) > 1 && onModeChange !== undefined
  const hasCommands = (commands?.length ?? 0) > 0
  const hasMentions = (mentions?.length ?? 0) > 0
  const showSlashTrigger = hasCommands && value === '' && !slashTriggerOpen

  const field = (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-expanded={open || mentionOpen || undefined}
      aria-controls={
        open ? `${menuId}-slash` : mentionOpen ? `${menuId}-mention` : undefined
      }
      aria-activedescendant={
        open && activeIndex >= 0
          ? `${menuId}-slash-opt-${activeIndex}`
          : mentionOpen && mentionActiveIndex >= 0
          ? `${menuId}-mention-opt-${mentionActiveIndex}`
          : undefined
      }
      aria-autocomplete={hasCommands || hasMentions ? 'list' : undefined}
      rows={1}
      dir="auto"
      spellCheck={spellcheck}
      onChange={(e) => {
        const next = e.target.value
        onChange(next)
        syncPalettes(next, e.target.selectionStart ?? next.length)
      }}
      onKeyDown={onKeyDown}
      onClick={(e) =>
        syncPalettes(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
      }
      onCompositionStart={() => {
        setSlash(null)
        setMention(null)
      }}
      onBlur={() => {
        setSlash(null)
        setMention(null)
        setSlashTriggerOpen(false)
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files)
        if (files.length > 0) {
          if (!onPasteFiles) return
          e.preventDefault()
          onPasteFiles(files)
          return
        }
        const text = e.clipboardData.getData('text/plain')
        if (text && onPasteText?.(text)) e.preventDefault()
      }}
    />
  )

  const slashTrigger = showSlashTrigger ? (
    <button
      type="button"
      className="ai-slash-trigger"
      title={slashTriggerTitle}
      aria-label={slashTriggerTitle ?? slashTriggerLabel}
      onMouseDown={(e) => e.preventDefault()}
      onClick={openSlashFromTrigger}
    >
      {slashTriggerLabel}
    </button>
  ) : null

  return (
    <div className="ai-input-box">
      {leading}
      {showModes && (
        <div className="ai-mode-switch" role="radiogroup" aria-label={modeSwitchLabel ?? 'Mode'}>
          {modes?.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={option.id === (mode ?? 'craft')}
              className={`ai-mode-btn${option.id === (mode ?? 'craft') ? ' on' : ''}`}
              title={option.title}
              onClick={() => onModeChange?.(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {header}
      {(hasCommands || hasMentions) ? (
        <div className="ai-input-field">
          {field}
          {open && (
            <AiComposerMenu
              idPrefix={`${menuId}-slash`}
              groups={groups}
              activeIndex={activeIndex}
              query={slash?.query ?? ''}
              label={commandMenuLabel}
              emptyLabel={commandMenuEmptyLabel}
              footHint={commandMenuFootHint}
              onPick={pickCommand}
              onHoverIndex={setActiveIndex}
            />
          )}
          {mentionOpen && (
            <AiMentionMenu
              idPrefix={`${menuId}-mention`}
              groups={rankedMentions.groups}
              activeIndex={mentionActiveIndex}
              query={mention?.query ?? ''}
              label={mentionMenuLabel}
              emptyLabel={mentionMenuEmptyLabel}
              footHint={mentionMenuFootHint}
              onPick={pickMention}
              onHoverIndex={setMentionActiveIndex}
            />
          )}
        </div>
      ) : (
        <>
          {slashTrigger}
          {field}
        </>
      )}
      <div className="ai-input-footer">
        {footerStart}
        {!iconOnly && (
          <span className="ai-input-hint" title={busy ? undefined : hintIdleTitle}>
            {busy ? hintBusy : hintIdle}
          </span>
        )}
        {slashTrigger && !(hasCommands || hasMentions) ? null : slashTrigger}
        {toolbar}
        {counter && (
          <span
            className={`ai-token-counter${counter.tone === 'warn' ? ' warn' : counter.tone === 'danger' ? ' danger' : ''}`}
            title={`${counter.tokens} tokens / ${counter.chars} chars`}
            aria-label={`${counter.tokens} of ${tokenBudget} tokens used`}
          >
            <span className="ai-token-bar" aria-hidden>
              <span style={{ width: `${Math.min(100, counter.ratio * 100)}%` }} />
            </span>
            {counter.label}
          </span>
        )}
        {voice && voice.available && (
          <button
            type="button"
            className={`ai-voice-btn${voice.active ? ' active' : ''}`}
            onClick={voice.active ? voice.onStop : voice.onStart}
            title={voice.label}
            aria-label={voice.label}
            aria-pressed={voice.active}
          >
            <IconMic size={16} />
            {!iconOnly && voice.label}
          </button>
        )}
        {busy ? (
          <button
            className="ai-send-btn ai-stop-btn"
            onClick={onStop}
            title={stopLabel}
            aria-label={stopLabel}
          >
            {iconOnly ? (stopIcon ?? <IconStop size={16} />) : <IconStop size={16} />}
            {!iconOnly && stopLabel}
          </button>
        ) : (
          <button
            className="ai-send-btn"
            onClick={onSend}
            disabled={!canSend}
            title={sendLabel}
            aria-label={sendLabel}
          >
            {iconOnly ? (
              ((canSend ? sendIconEnabled : (sendIconDisabled ?? sendIconEnabled)) ?? (
                <IconEnter size={16} />
              ))
            ) : (
              <IconSend size={16} />
            )}
            {!iconOnly && sendLabel}
          </button>
        )}
      </div>
    </div>
  )
}
