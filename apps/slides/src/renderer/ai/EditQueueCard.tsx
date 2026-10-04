/**
 * Pending element-scoped edits, shown above the composer. Thin adapter
 * over the shared `AiEditQueueCard`: rows are resolved against the live
 * deck on every render, so the element summary follows the current content
 * instead of a snapshot taken at annotation time.
 */
import React from 'react'
import type { ReactElement } from 'react'
import type { RenderSlide } from '@genoffice/pptx-render'
import { AiEditQueueCard, type AiEditQueueRow } from '@genoffice/ui'
import { useI18n } from '../i18n/locale'
import {
  describeNode,
  EDIT_INSTRUCTION_MAX,
  NODE_NOUN_KEY,
  resolveQueueItem,
  truncate,
  type EditQueueItem,
} from './edit-queue'

interface Props {
  items: EditQueueItem[]
  slides: RenderSlide[]
  busy: boolean
  onEditInstruction: (key: string, instruction: string) => void
  onRemove: (key: string) => void
  onDiscardAll: () => void
  onSend: () => void
  /** Jump to the page carrying this item and select its elements */
  onFocus: (key: string) => void
}

export function EditQueueCard({
  items,
  slides,
  busy,
  onEditInstruction,
  onRemove,
  onDiscardAll,
  onSend,
  onFocus,
}: Props): ReactElement | null {
  const { t } = useI18n()
  if (items.length === 0) return null
  const rows: AiEditQueueRow[] = items.map((item) => {
    const resolved = resolveQueueItem(slides, item)
    // the stored slideIndex is a cache; the resolved page wins when the deck moved
    const page = (resolved.ok ? resolved.slideIndex : item.slideIndex) + 1
    return {
      id: item.key,
      instruction: item.instruction,
      excerpt: resolved.ok
        ? resolved.nodes
            .map((n) => {
              const desc = describeNode(n)
              return desc.text ? truncate(desc.text, 24) : t(NODE_NOUN_KEY[desc.type])
            })
            .join(' / ')
        : null,
      stale: !resolved.ok,
      meta: t('aiScopeSlide', { n: page }),
    }
  })
  return (
    <AiEditQueueCard
      rows={rows}
      busy={busy}
      countLabel={t('aiQueueCount', { count: items.length })}
      // unresolved items may still ship: submission reports them instead of blocking
      canSend
      instructionMax={EDIT_INSTRUCTION_MAX}
      labels={{
        title: t('aiQueueTitle'),
        hint: t('aiQueueHint'),
        rowEdit: t('aiQueueRowEdit'),
        rowRemove: t('appCtxDelete'),
        discard: t('aiQueueDiscard'),
        cancel: t('paneCancel'),
        send: (_liveCount, totalCount) => t('aiQueueSend', { count: totalCount }),
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
