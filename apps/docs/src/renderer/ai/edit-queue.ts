import type { Editor } from '@tiptap/core'
import { NodeSelection, TextSelection, type Selection } from '@tiptap/pm/state'
import {
	buildQueueSummary,
	liveItems,
	EDIT_INSTRUCTION_MAX,
	EDIT_QUEUE_MAX,
	truncate,
	type LiveQueueItem,
	type ResolvedQueueItem,
} from '@genoffice/chat-runtime/edit-queue'
import { queueAnchorRange } from '../editor/ai-queue-anchors'

/**
 * Selection-scoped AI edit queue: the user annotates passages with short
 * instructions, they pile up in the AI panel, and the batch is submitted as
 * one agent run. Anchors live as decorations (ai-queue-anchors.ts), so they
 * migrate through edits character-precisely; block indexes are derived only
 * at render/submit time and never stored.
 *
 * Caps, truncation, the live/stale split and the submission summary are the
 * shared scaffolding in `@genoffice/chat-runtime/edit-queue`; what is docs'
 * own is the anchor resolution and the block-index batch instruction.
 */

export { EDIT_INSTRUCTION_MAX, EDIT_QUEUE_MAX, buildQueueSummary, liveItems, truncate }

export interface DocsEditQueueItem {
	qid: string
	instruction: string
	/** text snapshot at annotation time; the label of last resort once the anchor is gone */
	capturedText: string
}

export interface QueueBlockRange {
	startIndex: number
	endIndex: number
	excerpt: string
}

export type ResolvedDocsQueueItem = ResolvedQueueItem<DocsEditQueueItem, QueueBlockRange>
type LiveItem = LiveQueueItem<DocsEditQueueItem, QueueBlockRange>

/** top-level block index range covered by [from, to] */
function blockRangeOfPositions(
	editor: Editor,
	from: number,
	to: number,
): { startIndex: number; endIndex: number } {
	let startIndex = -1
	let endIndex = -1
	let index = 0
	editor.state.doc.forEach((node, offset) => {
		if (offset + node.nodeSize > from && offset < to) {
			if (startIndex === -1) startIndex = index
			endIndex = index
		}
		index++
	})
	if (startIndex === -1) {
		startIndex = editor.state.doc.childCount - 1
		endIndex = startIndex
	}
	return { startIndex, endIndex }
}

/** locate an item's anchor in the current document (block indexes + live excerpt) */
export function resolveQueueItem(editor: Editor, item: DocsEditQueueItem): ResolvedDocsQueueItem {
	const range = queueAnchorRange(editor.state, item.qid)
	if (!range) return { item, target: null }
	const indexes = blockRangeOfPositions(editor, range.from, range.to)
	const text = editor.state.doc
		.textBetween(range.from, range.to, '\n', ' ')
		.replace(/\s+/g, ' ')
		.trim()
	// a textless anchor (image/chart node selection) is still a live target —
	// label it by block type instead of declaring it orphaned
	const node = editor.state.doc.child(indexes.startIndex)
	const kind = (node.attrs.blockType as string | null) || node.type.name
	const excerpt = text || `(${kind} block, no text)`
	return { item, target: { ...indexes, excerpt } }
}

/**
 * Selection that focuses an anchor: a text selection cannot cover a block
 * atom (image/chart — TextSelection.create throws there), so an anchored
 * atom selects the node itself; TextSelection.between never throws.
 */
export function selectionForAnchor(editor: Editor, qid: string): Selection | null {
	const range = queueAnchorRange(editor.state, qid)
	if (!range) return null
	const doc = editor.state.doc
	const node = doc.nodeAt(range.from)
	if (node && !node.isText && !node.isTextblock && range.to <= range.from + node.nodeSize) {
		return NodeSelection.create(doc, range.from)
	}
	return TextSelection.between(doc.resolve(range.from), doc.resolve(range.to))
}

export function resolveQueue(editor: Editor, items: DocsEditQueueItem[]): ResolvedDocsQueueItem[] {
	return items.map((item) => resolveQueueItem(editor, item))
}

const blocksLabel = (target: QueueBlockRange): string =>
	target.startIndex === target.endIndex ? `Block ${target.startIndex}` : `Blocks ${target.startIndex}-${target.endIndex}`

/**
 * The batch instruction handed to the model (English regardless of UI
 * language). Edits are listed bottom-up so applying one never shifts the
 * block indexes of those still ahead in the list.
 */
export function buildQueueInstruction(entries: LiveItem[]): string {
	const ordered = [...entries].sort((a, b) => b.target.startIndex - a.target.startIndex)
	const lines = ordered.map(
		(entry, i) =>
			`${i + 1}. ${blocksLabel(entry.target)}, target text: "${truncate(entry.target.excerpt, 160)}"\n` +
			`   Requested change: ${entry.item.instruction}`,
	)
	return [
		'The user marked passages in the document and queued one edit per passage; apply them all now as a single batch.',
		'',
		'Edits to apply (block indexes refer to the current document block list; the list is ordered bottom-up so applying one edit does not shift the indexes of the following ones):',
		...lines,
		'',
		'Apply exactly these changes to exactly the listed target passages — verify the quoted target text before rewriting, and re-read with get_document_context if block counts changed unexpectedly. Do not modify content outside the listed targets. Finish with a short summary of what was changed.',
	].join('\n')
}
