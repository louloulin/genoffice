/**
 * Pending element-scoped edits, shown above the composer. Thin adapter
 * over the shared `AiEditQueueCard`: rows resolve their sids against the
 * live source on every render, so the excerpt follows the current content
 * instead of the snapshot taken at annotation time.
 */
import type { ReactElement } from 'react'
import { AiEditQueueCard, type AiEditQueueRow } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import type { ParseMap } from '../document/parse-map'
import {
  EDIT_INSTRUCTION_MAX,
  EDIT_QUEUE_MAX,
  liveItems,
  resolveQueue,
  truncate,
  type EditQueueItem,
} from './edit-queue'

interface Props {
  items: EditQueueItem[]
  text: string
  map: ParseMap
  busy: boolean
  onEditInstruction: (qid: string, instruction: string) => void
  onRemove: (qid: string) => void
  onDiscardAll: () => void
  onSend: () => void
  /** select the anchored element in the preview and source */
  onFocus: (qid: string) => void
}

export function EditQueueCard({
  items,
  text,
  map,
  busy,
  onEditInstruction,
  onRemove,
  onDiscardAll,
  onSend,
  onFocus,
}: Props): ReactElement | null {
  const { t } = useI18n()
  if (items.length === 0) return null
  const resolved = resolveQueue(text, map, items)
  const rows: AiEditQueueRow[] = resolved.map(({ item, target }) => ({
    id: item.qid,
    instruction: item.instruction,
    // a stale row keeps its annotation-time text as the label of last resort
    excerpt: target ? truncate(target.excerpt, 24) : item.capturedText,
    stale: target === null,
  }))
  return (
    <AiEditQueueCard
      rows={rows}
      busy={busy}
      countLabel={`${items.length}/${EDIT_QUEUE_MAX}`}
      canSend={liveItems(resolved).length > 0}
      instructionMax={EDIT_INSTRUCTION_MAX}
      labels={{
        title: t('aiQueueTitle'),
        hint: t('aiQueueHint'),
        orphan: t('aiQueueOrphan'),
        rowEdit: t('aiQueueRowEdit'),
        rowRemove: t('elementDelete'),
        discard: t('aiQueueDiscard'),
        cancel: t('aiAskCancel'),
        send: (liveCount) => t('aiQueueSend', { count: liveCount }),
        discardConfirm: (count) => t('aiQueueDiscardConfirm', { count }),
      }}
      onEditInstruction={onEditInstruction}
      onRemove={onRemove}
      onDiscardAll={onDiscardAll}
      onSend={onSend}
      onFocus={onFocus}
    />
  )
}
