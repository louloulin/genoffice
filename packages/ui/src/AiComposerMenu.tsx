/**
 * Slash-command palette rendered inside the shared AI composer.
 *
 * The composer owns the *state* (which `/query` is active, which row is
 * highlighted, whether Esc suppressed the menu); this component owns the
 * *rendering*, so the same palette serves every app and stays out of the
 * command-table business entirely.
 *
 * It receives the already-grouped commands rather than a flat list: the
 * composer derives its keyboard index space by flattening the very same
 * groups, so the highlighted row and the rendered rows can never disagree.
 *
 * Positioning is relative to the textarea wrapper (see ai-composer.css)
 * rather than a fixed anchored popover: the composer always sits at the
 * bottom of an AI panel, so "upwards from the field" is both the right place
 * and immune to the panel's scroll containers.
 *
 * Accessibility: the textarea keeps DOM focus and points at the highlighted
 * row through `aria-activedescendant`, so the listbox never steals the caret.
 * Rows cancel `mousedown` instead of taking focus — a click still fires, and
 * the user can keep typing without a focus round-trip.
 */
import React from 'react'
import { flattenComposerGroups } from './chat/composer-commands'
import type { ComposerCommand, ComposerCommandGroup } from './chat/composer-commands'

/** Wraps the query matches in `<mark>` so the row shows why it matched. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text
  const index = text.toLowerCase().indexOf(query.toLowerCase())
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="ai-cmd-mark">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}

export interface AiComposerMenuProps {
  readonly groups: readonly ComposerCommandGroup[]
  /** Index into the flattened group order — the order these rows render in. */
  readonly activeIndex: number
  /** The text typed after `/`; used for match highlighting. */
  readonly query: string
  /** Accessible name for the listbox. */
  readonly label: string
  /** Shown when nothing matches. */
  readonly emptyLabel: string
  /** One-line key legend at the bottom. */
  readonly footHint?: string | undefined
  readonly onPick: (command: ComposerCommand) => void
  /** Pointer hover moves the keyboard cursor too, so the two never diverge. */
  readonly onHoverIndex: (index: number) => void
  /** Prefix for option ids (`aria-activedescendant` targets). */
  readonly idPrefix: string
}

export function AiComposerMenu({
  groups,
  activeIndex,
  query,
  label,
  emptyLabel,
  footHint,
  onPick,
  onHoverIndex,
  idPrefix,
}: AiComposerMenuProps): React.JSX.Element {
  // Index of each row in the flattened order; the composer flattens the same
  // groups, so these are the ids `aria-activedescendant` points at.
  const indexOf = React.useMemo(() => {
    const map = new Map<ComposerCommand, number>()
    flattenComposerGroups(groups).forEach((cmd, index) => map.set(cmd, index))
    return map
  }, [groups])
  const empty = indexOf.size === 0

  return (
    <div
      className="ai-cmd-menu"
      role="listbox"
      aria-label={label}
      // the textarea owns focus; this element must never take it
      tabIndex={-1}
    >
      <div className="ai-cmd-query" aria-hidden>
        <span className="ai-cmd-slash">/</span>
        {query}
      </div>
      <div className="ai-cmd-scroll">
        {empty ? (
          <div className="ai-cmd-empty">{emptyLabel}</div>
        ) : (
          groups.map((group) => (
            <React.Fragment key={group.group || '·'}>
              {group.group !== '' && <div className="ai-cmd-group">{group.group}</div>}
              {group.commands.map((cmd) => {
                const index = indexOf.get(cmd) ?? -1
                const active = index === activeIndex
                return (
                  <button
                    key={cmd.id}
                    id={`${idPrefix}-opt-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`ai-cmd-row${active ? ' active' : ''}${
                      cmd.disabled ? ' disabled' : ''
                    }`}
                    disabled={cmd.disabled}
                    onMouseEnter={() => onHoverIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(cmd)}
                  >
                    <span className="ai-cmd-head">
                      <span className="ai-cmd-label">{highlight(cmd.label, query)}</span>
                      {cmd.hint !== undefined && cmd.hint !== '' && (
                        <span className="ai-cmd-tag">{cmd.hint}</span>
                      )}
                      <span className="ai-cmd-trigger">/{cmd.trigger}</span>
                    </span>
                    {cmd.description !== undefined && cmd.description !== '' && (
                      <span className="ai-cmd-desc">{highlight(cmd.description, query)}</span>
                    )}
                  </button>
                )
              })}
            </React.Fragment>
          ))
        )}
      </div>
      {footHint !== undefined && footHint !== '' && <div className="ai-cmd-foot">{footHint}</div>}
    </div>
  )
}
