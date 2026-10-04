/**
 * Shared AI edit-queue card (docs / markdown / html / slides): the pending
 * selection- or element-scoped edits shown above the composer, one row per
 * queued edit.
 *
 * Purely presentational. The host resolves its anchors against the live
 * document on every render and passes rows down, so excerpts follow the
 * current content instead of a snapshot taken at annotation time. All
 * strings arrive via `labels` (packages/ui has no i18n of its own); the
 * per-host behavioral differences are data, not branches: `stale` rows are
 * struck through and not focusable, and `canSend` gates the submit button
 * (docs/markdown/html disable it while no target resolves; slides submits
 * regardless and reports unresolved items).
 */
import React, { useState } from 'react'

export interface AiEditQueueRow {
  id: string
  instruction: string
  /** live target label (already truncated by the host); null → no chip */
  excerpt: string | null
  /** struck through, shows the orphan tooltip, click does not focus */
  stale: boolean
  /** optional leading chip (slides: the page label) */
  meta?: string
}

export interface AiEditQueueCardLabels {
  title: string
  hint: string
  /** tooltip on stale rows; omit where the host has no orphan concept */
  orphan?: string
  rowEdit: string
  rowRemove: string
  discard: string
  cancel: string
  /** live count first; slides labels by total instead */
  send: (liveCount: number, totalCount: number) => string
  discardConfirm: (totalCount: number) => string
}

interface Props {
  rows: AiEditQueueRow[]
  busy: boolean
  countLabel: string
  /** false disables Send (docs/markdown/html: no live rows) */
  canSend: boolean
  instructionMax: number
  labels: AiEditQueueCardLabels
  onEditInstruction: (id: string, instruction: string) => void
  onRemove: (id: string) => void
  onDiscardAll: () => void
  onSend: () => void
  onFocus: (id: string) => void
}

/** beyond this the list starts collapsed so it never swallows the transcript */
const AUTO_COLLAPSE_FROM = 4

export function AiEditQueueCard({
  rows,
  busy,
  countLabel,
  canSend,
  instructionMax,
  labels,
  onEditInstruction,
  onRemove,
  onDiscardAll,
  onSend,
  onFocus,
}: Props): React.JSX.Element | null {
  /** null = follow the length-based default; set once the user clicks the chevron */
  const [manualFold, setManualFold] = useState<boolean | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  if (rows.length === 0) return null
  const folded = manualFold ?? rows.length >= AUTO_COLLAPSE_FROM
  const liveCount = rows.filter((row) => !row.stale).length

  return (
    <div className="ai-queue">
      <div className="ai-queue-head">
        <span className="ai-queue-title">{labels.title}</span>
        <span className="ai-queue-count">{countLabel}</span>
        <button
          className={`ai-queue-fold${folded ? ' folded' : ''}`}
          onClick={() => setManualFold(!folded)}
          aria-expanded={!folded}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M4 6l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
      {!folded && (
        <>
          <div className="ai-queue-hint">{labels.hint}</div>
          <ol className="ai-queue-list">
            {rows.map((row, i) => (
              <li
                key={row.id}
                className={`ai-queue-row${row.stale ? ' stale' : ''}`}
                data-tip={row.stale ? labels.orphan : undefined}
                onClick={() => {
                  if (editingId !== row.id && !row.stale) onFocus(row.id)
                }}
              >
                <span className="ai-queue-ord">{i + 1}</span>
                {row.meta && <span className="ai-queue-meta">{row.meta}</span>}
                {editingId === row.id ? (
                  <input
                    className="ai-queue-edit-input"
                    value={draft}
                    autoFocus
                    maxLength={instructionMax}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      const next = draft.trim()
                      if (next) onEditInstruction(row.id, next)
                      setEditingId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault()
                        e.currentTarget.blur()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingId(null)
                      }
                    }}
                  />
                ) : (
                  <span className="ai-queue-text" title={row.instruction}>
                    {row.excerpt && <span className="ai-queue-target">{row.excerpt}</span>}
                    {row.instruction}
                  </span>
                )}
                <span className="ai-queue-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="ai-queue-row-btn"
                    data-tip={labels.rowEdit}
                    aria-label={labels.rowEdit}
                    disabled={busy}
                    onClick={() => {
                      setDraft(row.instruction)
                      setEditingId(row.id)
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M11.2 2.8l2 2L5.6 12.4l-2.6.6.6-2.6z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <button
                    className="ai-queue-row-btn"
                    data-tip={labels.rowRemove}
                    aria-label={labels.rowRemove}
                    disabled={busy}
                    onClick={() => onRemove(row.id)}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
                      <path
                        d="M4 4l8 8M12 4l-8 8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="ai-queue-foot">
        {confirmDiscard ? (
          <>
            <span className="ai-queue-confirm">{labels.discardConfirm(rows.length)}</span>
            <button className="ai-queue-discard" onClick={() => setConfirmDiscard(false)}>
              {labels.cancel}
            </button>
            <button
              className="ai-queue-send"
              onClick={() => {
                setConfirmDiscard(false)
                onDiscardAll()
              }}
            >
              {labels.discard}
            </button>
          </>
        ) : (
          <>
            <button className="ai-queue-discard" disabled={busy} onClick={() => setConfirmDiscard(true)}>
              {labels.discard}
            </button>
            <button
              className="ai-queue-send"
              disabled={busy || !canSend}
              onClick={onSend}
            >
              {labels.send(liveCount, rows.length)}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
