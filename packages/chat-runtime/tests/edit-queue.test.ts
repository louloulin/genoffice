import { describe, expect, it } from 'vitest'

import {
	EDIT_INSTRUCTION_MAX,
	EDIT_QUEUE_MAX,
	buildQueueSummary,
	liveItems,
	truncate,
} from '../src/edit-queue'

interface Item {
	qid: string
	instruction: string
}
interface Target {
	excerpt: string
	start: number
}

const item = (qid: string, instruction: string): Item => ({ qid, instruction })
const target = (excerpt: string, start: number): Target => ({ excerpt, start })

describe('edit-queue shared scaffolding', () => {
	it('caps match every host copy they replaced', () => {
		expect(EDIT_QUEUE_MAX).toBe(10)
		expect(EDIT_INSTRUCTION_MAX).toBe(500)
	})

	it('truncate appends an ellipsis only when shortening', () => {
		expect(truncate('short', 10)).toBe('short')
		expect(truncate('exactly-ten!', 10)).toBe('exactly-te…')
	})

	it('liveItems keeps only resolved entries and preserves host types', () => {
		const resolved = [
			{ item: item('a', 'first'), target: target('alpha', 3) },
			{ item: item('b', 'second'), target: null },
			{ item: item('c', 'third'), target: target('gamma', 1) },
		]
		const live = liveItems(resolved)
		expect(live.map((entry) => entry.item.qid)).toEqual(['a', 'c'])
		// the narrowed target is usable as the full host shape
		expect(live[0].target.start).toBe(3)
	})

	it('buildQueueSummary numbers entries with truncated excerpts', () => {
		const summary = buildQueueSummary('Queued edits:', [
			{ item: { instruction: 'fix typo' }, target: { excerpt: 'the first passage text' } },
			{ item: { instruction: 'polish wording' }, target: { excerpt: 'x'.repeat(40) } },
		])
		expect(summary).toBe(
			['Queued edits:', '1. the first passage text — fix typo', `2. ${'x'.repeat(24)}… — polish wording`].join('\n'),
		)
	})
})
