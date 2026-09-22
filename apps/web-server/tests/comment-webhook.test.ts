/**
 * Comment webhook events (sdk1.md §M4 §C backlog).
 *
 * Pins the contract that mutations on the comments store (`addComment`,
 * `resolveComment`, `removeComment`) trigger a `comment.*` webhook
 * delivery through `webhooks-store.fireCallback`, mirroring the
 * `file.saved` event the save pipeline already emits.
 *
 * We mock `../src/common/webhooks-store` with `vi.mock` (the only
 * reliable way to override a named export on an ESM module namespace)
 * and capture the calls to `fireCallback`. The mock factory is hoisted
 * via `vi.hoisted` so it runs before the comments-store import.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fireCallbackMock = vi.hoisted(() => vi.fn(async () => null))

vi.mock('../src/common/webhooks-store', () => ({
  fireCallback: fireCallbackMock,
  saveCallback: vi.fn(),
  getCallback: vi.fn(),
  listCallbacks: vi.fn(() => []),
  deleteCallback: vi.fn(),
  notifyFileSaved: vi.fn(),
  signWebhookBody: vi.fn(),
}))

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'comment-webhook-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
  fireCallbackMock.mockClear()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadComments() {
  return await import('../src/common/comments-store')
}

describe('comment webhook events (sdk1.md §M4 §C)', () => {
  it('addComment fires comment.added with id/author/text/anchor', async () => {
    const { addComment, _resetCommentsForTests } = await loadComments()
    _resetCommentsForTests()
    const c = addComment('doc-1', {
      author: 'alice',
      text: 'please review the conclusion',
      anchor: { range: { start: 100, end: 120 } },
    })
    // Lazy import → fire-and-forget microtask; flush.
    await new Promise((r) => setImmediate(r))
    expect(fireCallbackMock).toHaveBeenCalledTimes(1)
    expect(fireCallbackMock).toHaveBeenCalledWith(
      'comment.added',
      'doc-1',
      expect.objectContaining({
        commentId: c.id,
        author: 'alice',
        text: 'please review the conclusion',
        anchor: { range: { start: 100, end: 120 } },
        resolved: false,
        createdAt: expect.any(Number),
      }),
    )
  })

  it('resolveComment fires comment.resolved with the resolved flag flipped', async () => {
    const { addComment, resolveComment, _resetCommentsForTests } = await loadComments()
    _resetCommentsForTests()
    const c = addComment('doc-1', { author: 'alice', text: 'todo', anchor: {} })
    await new Promise((r) => setImmediate(r))
    fireCallbackMock.mockClear()
    const updated = resolveComment('doc-1', c.id, true)
    await new Promise((r) => setImmediate(r))
    expect(updated?.resolved).toBe(true)
    expect(fireCallbackMock).toHaveBeenCalledWith(
      'comment.resolved',
      'doc-1',
      expect.objectContaining({
        commentId: c.id,
        resolved: true,
        resolvedAt: expect.any(Number),
      }),
    )
  })

  it('removeComment fires comment.removed with the deleted comment body', async () => {
    const { addComment, removeComment, _resetCommentsForTests } = await loadComments()
    _resetCommentsForTests()
    const c = addComment('doc-1', { author: 'bob', text: 'remove me', anchor: { cell: 'A1' } })
    await new Promise((r) => setImmediate(r))
    fireCallbackMock.mockClear()
    expect(removeComment('doc-1', c.id)).toBe(true)
    await new Promise((r) => setImmediate(r))
    expect(fireCallbackMock).toHaveBeenCalledWith(
      'comment.removed',
      'doc-1',
      expect.objectContaining({
        commentId: c.id,
        author: 'bob',
        text: 'remove me',
        anchor: { cell: 'A1' },
      }),
    )
  })

  it('comment mutation still succeeds when fireCallback throws', async () => {
    // Configure the mock to reject — verifies that a flaky webhook
    // target doesn't propagate to the comment writer.
    fireCallbackMock.mockImplementationOnce(async () => {
      throw new Error('simulated delivery failure')
    })
    const { addComment, _resetCommentsForTests } = await loadComments()
    _resetCommentsForTests()
    const c = addComment('doc-1', { author: 'alice', text: 'survives', anchor: {} })
    expect(c.id).toMatch(/^cm_/)
    await new Promise((r) => setImmediate(r))
  })

  it('no callback registered: mutation still succeeds and the call still lands (DLQ is downstream)', async () => {
    // Even with no getCallback registered upstream, the comment-store
    // still invokes fireCallback — it is webhooks-store's job to skip
    // when there is no registered receiver for the fileId. The point
    // of this test is to make sure no exception escapes the mutation
    // path when the receiver chain returns null.
    fireCallbackMock.mockResolvedValueOnce(null)
    const { addComment, _resetCommentsForTests } = await loadComments()
    _resetCommentsForTests()
    expect(() =>
      addComment('doc-no-listener', { author: 'alice', text: 'silent', anchor: {} }),
    ).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(fireCallbackMock).toHaveBeenCalledTimes(1)
  })
})
