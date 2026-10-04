/**
 * Edit-queue scaffolding shared by every host app's selection-scoped AI edit
 * queue (docs/markdown: ProseMirror block anchors; html: parse-map sids;
 * slides: deck outline ids).
 *
 * The hosts own what genuinely differs — locating an item's anchor in *their*
 * document model, and the batch instruction's addressing scheme (block
 * indexes vs sids vs slide positions are different model contracts) — and
 * this module owns everything they used to copy: the caps, the truncation
 * helper, the live/stale split and the user-facing submission summary.
 */

/** Hard cap on queued edits: keeps one submission inside the agent's turn budget and the card readable */
export const EDIT_QUEUE_MAX = 10
/** Soft cap on one instruction; longer requests belong in the main composer */
export const EDIT_INSTRUCTION_MAX = 500

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text
}

/** A resolved queue entry: the host's item plus its host-shaped target, or null once stale. */
export interface ResolvedQueueItem<TItem, TTarget> {
	item: TItem
	/** null = the anchored target no longer exists */
	target: TTarget | null
}

export type LiveQueueItem<TItem, TTarget> = ResolvedQueueItem<TItem, TTarget> & { target: TTarget }

/** Entries whose anchor still resolves in the live document — the ones a submission will carry. */
export function liveItems<TItem, TTarget>(
	resolved: ReadonlyArray<ResolvedQueueItem<TItem, TTarget>>,
): Array<LiveQueueItem<TItem, TTarget>> {
	return resolved.filter((entry): entry is LiveQueueItem<TItem, TTarget> => entry.target !== null)
}

/**
 * User-facing echo of a submission, shown as the chat bubble text. The
 * batch-order key each host lists by (block index, sid, slide) lives in the
 * host's instruction builder; this summary only needs the live excerpt.
 */
export function buildQueueSummary(
	header: string,
	entries: ReadonlyArray<{ item: { instruction: string }; target: { excerpt: string } }>,
): string {
	const lines = entries.map(
		(entry, index) => `${index + 1}. ${truncate(entry.target.excerpt, 24)} — ${entry.item.instruction}`,
	)
	return [header, ...lines].join('\n')
}
