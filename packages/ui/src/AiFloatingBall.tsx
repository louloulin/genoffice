/**
 * Draggable AI assistant ball — the collapsed form of `data-ai-placement="floating"`.
 *
 * The six apps each render a collapsed slot already (docs/slides in `AiPanel.tsx`,
 * html/markdown/pdf in `App.tsx`, sheets in `AiChatPanel.tsx`); this component
 * replaces that slot's rail when the effective placement is `floating`, so the
 * ball lands in markup the app already keeps mounted and no portal is needed.
 * `ai-panel-placement.css` puts the surrounding dock at `display: contents` in
 * that mode, which is what lets a `position: fixed` child resolve against the
 * viewport.
 *
 * The brand mark stays with the host (`children`) — docs/slides/sheets pass
 * `ProviderMark`, the rest `DataflareMark` — so this file owns behaviour only.
 *
 * Position is viewport-relative layout state, not a preference: it is stored in
 * `localStorage` exactly like the panel width each app already keeps there, and
 * deliberately not in `AiPanelPrefs`, which the shell syncs machine-to-machine
 * and which would carry a laptop coordinate onto a desktop monitor.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export interface AiFloatingBallProps {
  /** Accessible name and tooltip, localised by the host. */
  label: string
  /** Called on a click that did not drag. */
  onOpen: () => void
  /** Brand mark rendered inside the ball. */
  children?: React.ReactNode
  className?: string
}

const BALL_SIZE = 40
/** Same inset the overlay card uses, so the two collapsed/expanded forms line up. */
const EDGE = 16
/** Below this the gesture is a click, not a drag — matches TabBar.tsx's tab reorder. */
const DRAG_THRESHOLD = 4
const STORAGE_KEY = 'genoffice-ai-ball'

interface BallPos {
  x: number
  y: number
}

function clamp(pos: BallPos): BallPos {
  const maxX = Math.max(EDGE, window.innerWidth - BALL_SIZE - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - BALL_SIZE - EDGE)
  return { x: Math.min(Math.max(EDGE, pos.x), maxX), y: Math.min(Math.max(EDGE, pos.y), maxY) }
}

function readStored(): BallPos | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { x, y } = parsed as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') return null
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch {
    return null
  }
}

function writeStored(pos: BallPos): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }))
  } catch {
    // A blocked storage (private mode, quota) must not break the drag.
  }
}

/** Bottom-right when nothing has been stored yet — same corner the overlay card opens in. */
function defaultPos(): BallPos {
  return clamp({ x: window.innerWidth - BALL_SIZE - EDGE, y: window.innerHeight - BALL_SIZE - EDGE })
}

export function AiFloatingBall(props: AiFloatingBallProps): React.JSX.Element | null {
  const { label, onOpen, children, className } = props
  const [pos, setPos] = useState<BallPos | null>(null)
  // Read once into a ref so the pointer handlers never depend on state timing.
  const posRef = useRef<BallPos | null>(null)
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: BallPos; moved: boolean } | null>(
    null,
  )
  // Survives past pointerup: a drag still emits a click, and endDrag() has already
  // cleared dragRef by then.
  const suppressClickRef = useRef(false)

  const commit = useCallback((next: BallPos) => {
    posRef.current = next
    setPos(next)
  }, [])

  // Measured before paint so the ball never flashes in the top-left corner.
  useLayoutEffect(() => {
    const restore = () => {
      const stored = readStored()
      commit(clamp(stored ?? defaultPos()))
    }
    restore()
    // A window resize can leave a stored position off-screen; re-clamp rather
    // than keep the stale coordinate.
    window.addEventListener('resize', restore)
    return () => window.removeEventListener('resize', restore)
  }, [commit])

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!posRef.current) return
    if (e.button !== 0) return
    suppressClickRef.current = false
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: posRef.current,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current
    if (!drag || e.pointerId !== drag.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return
    drag.moved = true
    commit(clamp({ x: drag.origin.x + dx, y: drag.origin.y + dy }))
  }

  const endDrag = (pointerId: number) => {
    const drag = dragRef.current
    if (!drag || pointerId !== drag.pointerId) return
    dragRef.current = null
    if (drag.moved) {
      suppressClickRef.current = true
      if (posRef.current) writeStored(posRef.current)
    }
  }

  if (!pos) return null

  return (
    <button
      type="button"
      className={['ai-floating-ball', className].filter(Boolean).join(' ')}
      style={{ left: `${Math.round(pos.x)}px`, top: `${Math.round(pos.y)}px` }}
      data-tip={label}
      aria-label={label}
      onClick={() => {
        // A drag also emits a click; only a stationary press opens the panel.
        if (suppressClickRef.current) return
        onOpen()
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e.pointerId)}
      onPointerCancel={(e) => endDrag(e.pointerId)}
      onLostPointerCapture={(e) => endDrag(e.pointerId)}
    >
      {children}
    </button>
  )
}
