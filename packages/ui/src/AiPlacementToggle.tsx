/**
 * Dock ⇄ floating switch for the AI panel header.
 *
 * The six apps each render their own panel header, so this owns the behaviour
 * and the two glyphs while the host supplies the labels — shared components
 * carry no translations of their own (see AiFloatingBall).
 *
 * It reuses the host's `.ai-header-btn` class, which every app already styles,
 * rather than shipping a stylesheet: the button must look like the collapse and
 * glossary controls beside it.
 */

import React from 'react'
import { setAiPanelPlacement, useAiPanelPlacement } from './ai-panel-prefs-store'

export interface AiPlacementToggleProps {
  /** Tooltip and accessible name while docked — what the click does next. */
  toFloatingLabel: string
  /** Tooltip and accessible name while floating — what the click does next. */
  toDockedLabel: string
  className?: string
}

const GLYPH = 15

function Glyph({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={GLYPH}
      height={GLYPH}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** Panel docked against a side, its divider drawn at the edge it sits on. */
function IconDock(): React.JSX.Element {
  return (
    <Glyph>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M10.5 2.5v11" />
      <path d="M6.4 8h3.8M8.7 6.9 9.8 8 8.7 9.1" strokeWidth="1.3" />
    </Glyph>
  )
}

/** Content, with the assistant collapsed to a ball floating over its corner. */
function IconFloat(): React.JSX.Element {
  return (
    <Glyph>
      <rect x="1.5" y="2.5" width="13" height="8" rx="1" />
      <circle cx="12" cy="12" r="3.1" fill="currentColor" stroke="none" />
    </Glyph>
  )
}

export function AiPlacementToggle(props: AiPlacementToggleProps): React.JSX.Element {
  const { toFloatingLabel, toDockedLabel, className } = props
  const floating = useAiPanelPlacement() === 'floating'
  const label = floating ? toDockedLabel : toFloatingLabel
  return (
    <button
      type="button"
      className={['ai-header-btn', 'ai-placement-toggle', className].filter(Boolean).join(' ')}
      // Floating restores the default docked side; a panel deliberately set to
      // `left` in Settings returns to `right`, which the tooltip states.
      onClick={() => setAiPanelPlacement(floating ? 'right' : 'floating')}
      data-tip={label}
      aria-label={label}
      aria-pressed={floating}
    >
      {floating ? <IconDock /> : <IconFloat />}
    </button>
  )
}
