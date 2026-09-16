import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IconEnter, IconMic, IconSend, IconStop } from './icons'
import { useAiPanelPrefs } from './ai-panel-prefs-store'
import { AiComposerMenu } from './AiComposerMenu'
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

/**
 * The AI panel input box shared by every app: auto-growing textarea
 * (Enter sends, Shift+Enter newline, Esc stops) plus a footer with optional
 * app-specific controls, a shortcut hint, and the send/stop button.
 * Renders the `.ai-input-box` class family; each app themes it in its own CSS.
 *
 * Three optional extras turn it into a ChatComposer, and all of them are
 * additive — with none of them passed the markup is unchanged:
 *
 *  - `commands` / `onCommandPick`: typing `/` at the start of the text (or
 *    after whitespace) opens a grouped palette of app-supplied actions,
 *    skills and templates. The composer only knows the `ComposerCommand`
 *    shape, never what a "skill" is, so each app decides its own table.
 *  - `modes` / `mode` / `onModeChange`: an Ask / Craft / Plan switch above
 *    the textarea. The *behaviour* lives in `chat/modes.ts` — the app appends
 *    that directive to its system prompt; the composer only reflects the
 *    current choice.
 *  - `toolbar` / `leading`: slots for app chrome (model picker, counters) on
 *    either side of the footer.
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
  modes,
  mode,
  onModeChange,
  modeSwitchLabel,
  toolbar,
  leading,
  voice,
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
  /** custom art for the icon-only send button (e.g. brand-supplied PNGs); falls back to IconEnter */
  readonly sendIconEnabled?: React.ReactNode
  readonly sendIconDisabled?: React.ReactNode
  /** custom art for the icon-only stop button while busy; falls back to IconStop */
  readonly stopIcon?: React.ReactNode
  /** pass a ref to focus the textarea from outside */
  readonly textareaRef?: React.RefObject<HTMLTextAreaElement | null> | undefined
  readonly onChange: (next: string) => void
  readonly onSend: () => void
  readonly onStop: () => void
  /** clipboard files pasted into the textarea (screenshots, copied files); text paste stays native */
  readonly onPasteFiles?: ((files: File[]) => void) | undefined
  /** first look at pasted text; return true to consume it (e.g. a base64 image turned into an attachment) */
  readonly onPasteText?: ((text: string) => boolean) | undefined
  /** slash-command table; omit (or pass an empty array) to disable the palette */
  readonly commands?: readonly ComposerCommand[] | undefined
  /**
   * Picked a command. `value` is the composer's text after the `/query` was
   * consumed — apply it to your state, then run whatever the command means
   * (`kind: 'run'` acts here; `kind: 'insert'` only needs the text to land).
   */
  readonly onCommandPick?: ((pick: ComposerCommandPick) => void) | undefined
  /** accessible name for the palette listbox */
  readonly commandMenuLabel?: string | undefined
  readonly commandMenuEmptyLabel?: string | undefined
  /** key legend under the palette rows */
  readonly commandMenuFootHint?: string | undefined
  /** modes this panel offers; omit to hide the switch entirely */
  readonly modes?: readonly ComposerModeOption[] | undefined
  readonly mode?: ChatMode | undefined
  readonly onModeChange?: ((mode: ChatMode) => void) | undefined
  /** accessible name for the mode radiogroup */
  readonly modeSwitchLabel?: string | undefined
  /** Voice input. The composer only renders the mic; the host owns the
   *  Web Speech API (or native bridge) and pushes interim transcripts through
   *  `onChange`. `available=false` hides the button entirely. */
  readonly voice?: {
    readonly available: boolean | undefined
    readonly active: boolean | undefined
    readonly label: string
    readonly onStart: () => void
    readonly onStop: () => void
  } | undefined
  /** right-hand footer slot, before the send button (model picker, counters, …) */
  readonly toolbar?: React.ReactNode
  /** left-hand slot inside the box, above the textarea, aligned with `header` */
  readonly leading?: React.ReactNode
}): React.JSX.Element {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  const ref = textareaRef ?? innerRef
  const canSend = value.trim().length > 0 && !busy
  const { spellcheck } = useAiPanelPrefs()

  const [slash, setSlash] = useState<SlashQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  // Esc hides the palette for the *current* `/query` only: editing the query
  // clears this, so Esc never feels sticky.
  const [dismissed, setDismissed] = useState<string | null>(null)

  const menuId = React.useId()

  const ranked = useMemo(
    () =>
      slash !== null && commands && commands.length > 0
        ? filterComposerCommands(commands, slash.query)
        : [],
    [slash, commands],
  )
  // Rows render grouped; the keyboard walks the same flattened order so the
  // highlight can never sit on a different row than the one Enter would take.
  const groups = useMemo(() => groupComposerCommands(ranked, ''), [ranked])
  const rows = useMemo(() => flattenComposerGroups(groups), [groups])

  // The palette opens for *any* valid `/query`, including one with no match:
  // silently swallowing the keystrokes would leave the user with no feedback
  // about why nothing happened.
  const open = slash !== null && dismissed !== slash.query

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

  const syncSlash = useCallback((next: string, caret: number) => {
    const found = activeSlashQuery(next, caret)
    setSlash(found)
    // a different query means the user is looking again — un-dismiss
    setDismissed((d) => (found !== null && d !== null && d !== found.query ? null : d))
  }, [])

  const pick = useCallback(
    (cmd: ComposerCommand) => {
      if (cmd.disabled || slash === null) return
      const applied = applyComposerCommand(value, slash, cmd)
      setSlash(null)
      setDismissed(null)
      setActiveIndex(0)
      onChange(applied.value)
      onCommandPick?.({
        command: cmd,
        value: applied.value,
        caret: applied.caret,
        query: slash.query,
      })
      // the caret must be restored after React commits the new value
      requestAnimationFrame(() => {
        const ta = ref.current
        if (!ta) return
        ta.focus()
        ta.setSelectionRange(applied.caret, applied.caret)
      })
    },
    [slash, value, onChange, onCommandPick, ref],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return
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
          pick(cmd)
          return
        }
      }
      if (e.key === 'Escape') {
        // only swallow Esc while the palette is open; otherwise it must still
        // reach the "stop the run" branch below
        e.preventDefault()
        setDismissed(slash?.query ?? '')
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

  const field = (
    <textarea
      ref={ref}
      value={value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-expanded={open || undefined}
      aria-controls={open ? `${menuId}-menu` : undefined}
      aria-activedescendant={
        open && activeIndex >= 0 ? `${menuId}-menu-opt-${activeIndex}` : undefined
      }
      aria-autocomplete={hasCommands ? 'list' : undefined}
      rows={1}
      dir="auto"
      spellCheck={spellcheck}
      onChange={(e) => {
        const next = e.target.value
        onChange(next)
        syncSlash(next, e.target.selectionStart ?? next.length)
      }}
      onKeyDown={onKeyDown}
      // clicking elsewhere in the text can move the caret back into an
      // existing `/query`, so the palette follows the caret, not just typing
      onClick={(e) => syncSlash(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
      onCompositionStart={() => setSlash(null)}
      onBlur={() => setSlash(null)}
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
      {hasCommands ? (
        // the wrapper only exists to anchor the palette above the field; with
        // no command table it is omitted so the markup stays as it was
        <div className="ai-input-field">
          {field}
          {open && (
            <AiComposerMenu
              idPrefix={`${menuId}-menu`}
              groups={groups}
              activeIndex={activeIndex}
              query={slash?.query ?? ''}
              label={commandMenuLabel}
              emptyLabel={commandMenuEmptyLabel}
              footHint={commandMenuFootHint}
              onPick={pick}
              onHoverIndex={setActiveIndex}
            />
          )}
        </div>
      ) : (
        field
      )}
      <div className="ai-input-footer">
        {footerStart}
        {!iconOnly && (
          <span className="ai-input-hint" title={busy ? undefined : hintIdleTitle}>
            {busy ? hintBusy : hintIdle}
          </span>
        )}
        {toolbar}
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
