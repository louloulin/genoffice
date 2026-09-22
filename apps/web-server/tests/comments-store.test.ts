/**
 * Comments storage (sdk1.md §B.5.1 #4, Kestrel M2).
 *
 * Pins the contract of `apps/web-server/src/common/comments-store.ts`:
 *
 *   1. addComment assigns a stable id, stamps author from caller, defaults
 *      resolved=false, sets createdAt = Date.now().
 *   2. listComments returns a fresh array (not a reference into the
 *      store) so callers can't accidentally mutate cached state.
 *   3. listComments filters by resolved boolean and parentId.
 *   4. resolveComment sets resolvedAt on first resolve; toggles preserve
 *      the original timestamp.
 *   5. removeComment is hard-delete; returns false on unknown id.
 *   6. getComment returns null on unknown id.
 *   7. Persistence to disk is restart-safe (load() recovers the JSON).
 *   8. _resetCommentsForTests clears state for the next test.
 *
 * The test uses a temp DATA_DIR via vi.hoisted + vi.stubEnv so the
 * comments.json write path stays hermetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.hoisted(() => {
  process.env.GENOFFICE_JWT_SECRET = 'comments-store-test-secret'
})

// Set env BEFORE importing modules that read process.env at module init.
const TMP = mkdtempSync(join(tmpdir(), 'comments-store-'))
process.env.GENOFFICE_TEST_DATA_DIR = TMP
process.env.DATA_DIR = TMP
vi.stubEnv('DATA_DIR', TMP)

import {
  _resetCommentsForTests,
  addComment,
  commentCountForFile,
  getComment,
  listComments,
  removeComment,
  resolveComment,
  totalCommentCount,
} from '../src/common/comments-store'
import { DATA_DIR } from '../src/common/state'

beforeEach(() => {
  _resetCommentsForTests()
})

afterEach(() => {
  _resetCommentsForTests()
})

describe('comments-store (sdk1.md §B.5.1 #4 Kestrel M2)', () => {
  it('addComment assigns an id, stamps author, sets resolved=false', () => {
    const c = addComment('doc-1', {
      author: 'user-1',
      text: 'first comment',
      anchor: { cell: 'A1' },
    })
    expect(c.id).toMatch(/^cm_[A-Za-z0-9_-]+$/)
    expect(c.author).toBe('user-1')
    expect(c.text).toBe('first comment')
    expect(c.anchor).toEqual({ cell: 'A1' })
    expect(c.resolved).toBe(false)
    expect(c.resolvedAt).toBeUndefined()
    expect(typeof c.createdAt).toBe('number')
    expect(c.createdAt).toBeGreaterThan(0)
  })

  it('listComments returns a fresh array (caller mutation safe)', () => {
    addComment('doc-1', { author: 'u', text: 'a', anchor: { cell: 'A1' } })
    const list = listComments('doc-1')
    expect(list).toHaveLength(1)
    list.length = 0
    list[0] = null as unknown
    const second = listComments('doc-1')
    expect(second).toHaveLength(1)
    expect(second[0]!.text).toBe('a')
  })

  it('listComments filters by resolved boolean', () => {
    const a = addComment('doc-1', { author: 'u', text: 'open', anchor: { cell: 'A1' } })
    const b = addComment('doc-1', { author: 'u', text: 'will-resolve', anchor: { cell: 'A2' } })
    resolveComment('doc-1', b.id, true)
    expect(listComments('doc-1', { resolved: false }).map((c) => c.id)).toEqual([a.id])
    expect(listComments('doc-1', { resolved: true }).map((c) => c.id)).toEqual([b.id])
    expect(listComments('doc-1').map((c) => c.id).sort()).toEqual([a.id, b.id].sort())
  })

  it('listComments filters by parentId', () => {
    const parent = addComment('doc-1', { author: 'u', text: 'parent', anchor: { cell: 'A1' } })
    addComment('doc-1', { author: 'u', text: 'reply-1', anchor: { cell: 'A1' }, parentId: parent.id })
    addComment('doc-1', { author: 'u', text: 'reply-2', anchor: { cell: 'A1' }, parentId: parent.id })
    expect(listComments('doc-1').filter((c) => !c.parentId).map((c) => c.id)).toEqual([parent.id])
    expect(listComments('doc-1', { parentId: parent.id })).toHaveLength(2)
  })

  it('resolveComment sets resolvedAt on first resolve; toggles preserve it', async () => {
    const c = addComment('doc-1', { author: 'u', text: 'a', anchor: { cell: 'A1' } })
    expect(c.resolvedAt).toBeUndefined()
    const r1 = resolveComment('doc-1', c.id, true)
    expect(r1?.resolved).toBe(true)
    expect(typeof r1?.resolvedAt).toBe('number')
    const firstResolvedAt = r1!.resolvedAt!
    // Toggle off then on; resolvedAt must NOT change.
    resolveComment('doc-1', c.id, false)
    const r3 = resolveComment('doc-1', c.id, true)
    expect(r3?.resolvedAt).toBe(firstResolvedAt)
  })

  it('resolveComment returns null on unknown id', () => {
    expect(resolveComment('doc-1', 'cm_nonexistent', true)).toBeNull()
  })

  it('removeComment is hard-delete; returns false on unknown id', () => {
    const c = addComment('doc-1', { author: 'u', text: 'a', anchor: { cell: 'A1' } })
    expect(removeComment('doc-1', c.id)).toBe(true)
    expect(getComment('doc-1', c.id)).toBeNull()
    expect(removeComment('doc-1', c.id)).toBe(false)
    expect(removeComment('doc-1', 'cm_nope')).toBe(false)
  })

  it('getComment returns null on unknown id', () => {
    expect(getComment('doc-1', 'cm_nope')).toBeNull()
  })

  it('persists comments.json to DATA_DIR (restart-safe)', () => {
    addComment('doc-A', { author: 'u', text: 'persisted', anchor: { cell: 'A1' } })
    addComment('doc-B', { author: 'u', text: 'other-file', anchor: { cell: 'B1' } })
    // DATA_DIR is resolved at module init from process.env.DATA_DIR
    // (which the setup section stubs to TMP). The store writes to
    // `${DATA_DIR}/comments.json`.
    const path = join(DATA_DIR, 'comments.json')
    expect(existsSync(path)).toBe(true)
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['doc-A', 'doc-B'])
    expect(raw['doc-A'][0].text).toBe('persisted')
    expect(raw['doc-B'][0].text).toBe('other-file')
  })

  it('totalCommentCount + commentCountForFile helper', () => {
    expect(totalCommentCount()).toBe(0)
    addComment('doc-1', { author: 'u', text: 'a', anchor: { cell: 'A1' } })
    addComment('doc-1', { author: 'u', text: 'b', anchor: { cell: 'A2' } })
    addComment('doc-2', { author: 'u', text: 'c', anchor: { cell: 'A1' } })
    expect(totalCommentCount()).toBe(3)
    expect(commentCountForFile('doc-1')).toBe(2)
    expect(commentCountForFile('doc-2')).toBe(1)
    expect(commentCountForFile('doc-3')).toBe(0)
  })

  it('parentId is round-tripped (replies survive storage)', () => {
    const parent = addComment('doc-1', { author: 'u', text: 'p', anchor: { cell: 'A1' } })
    const reply = addComment('doc-1', {
      author: 'u', text: 'r', anchor: { cell: 'A1' }, parentId: parent.id,
    })
    expect(reply.parentId).toBe(parent.id)
    const fetched = getComment('doc-1', reply.id)
    expect(fetched?.parentId).toBe(parent.id)
  })
})
