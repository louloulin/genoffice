/**
 * @-mention palette rendered inside the shared AI composer.
 *
 * Mirrors `AiComposerMenu` so the two popovers feel like one component:
 *   - the composer owns the *state* (active `@query`, highlighted row)
 *   - this component owns the *rendering* (groups, rows, ARIA listbox)
 *
 * The same `aria-activedescendant` trick keeps focus on the textarea: the
 * picker is `tabIndex={-1}` and rows cancel `mousedown` so the user can keep
 * typing without a focus round-trip.
 *
 * Differences vs the slash palette:
 *   - rows render a kind-specific glyph on the left (📄 / 📊 / 🤖 / …)
 *   - the right-aligned hint shows the kind, not a free-form tag
 *   - empty-state copy is mention-specific ("Pick a file")
 */
import React from 'react'
import {
  flattenMentionGroups,
  type MentionEntry,
  type MentionGroup,
  type MentionKind,
} from './chat/mentions'

/** Coarse glyph for each mention kind — small, monochrome, currentColor. */
function kindGlyph(kind: MentionKind): React.ReactNode {
  switch (kind) {
    case 'file':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <path d="M3 2h6l2 2v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M9 2v2h2" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )
    case 'folder':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <path d="M2 4h4l2 2h6v6a1 1 0 01-1 1H3a1 1 0 01-1-1V4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      )
    case 'block':
    case 'page':
    case 'doc':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <path d="M3 2h6l2 2v9a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zM4 7h6M4 9h6M4 11h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
    case 'sheet':
    case 'range':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <path d="M2 3h12v10H2zM2 7h12M2 10h12M5 3v10M9 3v10" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'agent':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <circle cx="8" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 13c1-2 3-3 5-3s4 1 5 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )
    case 'skill':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <path d="M3 13l3-3 2 2 4-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'web':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )
    case 'image':
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="6" cy="7" r="1.3" stroke="currentColor" strokeWidth="1.2" />
          <path d="M2 11l4-3 3 3 5-4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      )
    default:
      return (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden>
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )
  }
}

/** Highlight the substring that matched the query. */
function highlight(text: string, query: string): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const q = query.toLowerCase()
  const index = lower.indexOf(q)
  if (index < 0) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="ai-cmd-mark">{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  )
}

export interface AiMentionMenuProps {
  readonly groups: readonly MentionGroup[]
  /** Index into the flattened group order — the order these rows render in. */
  readonly activeIndex: number
  /** The text typed after `@`; used for match highlighting. */
  readonly query: string
  /** Accessible name for the listbox. */
  readonly label: string
  /** Shown when nothing matches. */
  readonly emptyLabel: string
  /** One-line key legend at the bottom. */
  readonly footHint?: string | undefined
  readonly onPick: (entry: MentionEntry) => void
  /** Pointer hover moves the keyboard cursor too, so the two never diverge. */
  readonly onHoverIndex: (index: number) => void
  /** Prefix for option ids (`aria-activedescendant` targets). */
  readonly idPrefix: string
}

export function AiMentionMenu({
  groups,
  activeIndex,
  query,
  label,
  emptyLabel,
  footHint,
  onPick,
  onHoverIndex,
  idPrefix,
}: AiMentionMenuProps): React.JSX.Element {
  // Map entries to their flattened index so keyboard + pointer agree.
  const indexOf = React.useMemo(() => {
    const map = new Map<MentionEntry, number>()
    flattenMentionGroups(groups).forEach((entry, index) => map.set(entry, index))
    return map
  }, [groups])
  const empty = indexOf.size === 0

  return (
    <div
      className="ai-cmd-menu ai-mention-menu"
      role="listbox"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="ai-cmd-query" aria-hidden>
        <span className="ai-cmd-slash">@</span>
        {query}
      </div>
      <div className="ai-cmd-scroll">
        {empty ? (
          <div className="ai-cmd-empty">{emptyLabel}</div>
        ) : (
          groups.map((group) => (
            <React.Fragment key={group.group || '·'}>
              {group.group !== '' && <div className="ai-cmd-group">{group.group}</div>}
              {group.entries.map((entry) => {
                const index = indexOf.get(entry) ?? -1
                const active = index === activeIndex
                return (
                  <button
                    key={entry.id}
                    id={`${idPrefix}-opt-${index}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`ai-cmd-row${active ? ' active' : ''}${entry.disabled ? ' disabled' : ''}`}
                    disabled={entry.disabled}
                    onMouseEnter={() => onHoverIndex(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(entry)}
                  >
                    <span className="ai-mention-kind" aria-hidden>{kindGlyph(entry.kind)}</span>
                    <span className="ai-cmd-head">
                      <span className="ai-cmd-label">{highlight(entry.label, query)}</span>
                      {entry.hint !== undefined && entry.hint !== '' && (
                        <span className="ai-cmd-tag">{entry.hint}</span>
                      )}
                      <span className="ai-cmd-trigger">@{entry.trigger}</span>
                    </span>
                    {entry.description !== undefined && entry.description !== '' && (
                      <span className="ai-cmd-desc">{highlight(entry.description, query)}</span>
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
