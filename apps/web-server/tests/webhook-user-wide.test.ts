/**
 * User-wide (a.k.a. org-wide) webhook subscription routing (sdk1.md §11.93).
 *
 * Pins the contract that `webhooks:upsert` registers a subscription that
 * receives EVERY event the server fires (file-scoped or comment events),
 * not just events whose `fileId` happens to be the synthetic `user:<sub>`
 * key. Previous behavior stored user subs in `byFile` under a
 * `user:<sub>` key, which meant `fireCallback('comment.added', fileId)`
 * could never reach an org-wide subscriber.
 *
 * `fireCallback` is now a multi-recipient dispatch:
 *   - the per-file `byFile[fileId]` (if registered) gets the event
 *   - every entry in `byUser` that has the event in its whitelist also
 *     gets the event (subject to URL dedup so a per-file + org-wide
 *     subscription on the same URL is delivered once)
 *
 * Delivery shape is unchanged: each delivery still gets its own retry
 * budget, its own attempt counter, and its own DLQ entry on failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let TMP = ''

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'webhook-user-wide-'))
  vi.stubEnv('DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_DATA_DIR', TMP)
  vi.stubEnv('GENOFFICE_WEB_DATA_DIR', TMP)
  vi.resetModules()
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function loadStore() {
  return await import('../src/common/webhooks-store')
}

describe('user-wide webhook subscription routing (sdk1.md §11.93)', () => {
  it('saveCallbackForUser stores under byUser, not byFile', async () => {
    const { saveCallbackForUser, getCallbackForUser, getCallback, listCallbacks, listUserCallbacks } =
      await loadStore()
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/org',
      events: ['file.saved', 'comment.added'],
      createdAt: Date.now(),
    })
    expect(getCallbackForUser('alice@acme.com')?.url).toBe('https://hook.test/org')
    // The synthetic `user:<sub>` key MUST NOT appear in the file-scoped list.
    expect(getCallback('user:alice@acme.com')).toBeUndefined()
    expect(listCallbacks()).toEqual([])
    expect(listUserCallbacks()).toHaveLength(1)
    expect(listUserCallbacks()[0]!.url).toBe('https://hook.test/org')
  })

  it('deleteCallbackForUser removes only the user sub', async () => {
    const { saveCallbackForUser, saveCallback, deleteCallbackForUser, getCallbackForUser, getCallback } =
      await loadStore()
    saveCallback({ fileId: 'doc.docx', url: 'https://hook.test/file', events: ['file.saved'], createdAt: Date.now() })
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/org',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    expect(deleteCallbackForUser('alice@acme.com')).toBe(true)
    expect(getCallbackForUser('alice@acme.com')).toBeUndefined()
    expect(deleteCallbackForUser('alice@acme.com')).toBe(false)
    // Per-file subscription is untouched.
    expect(getCallback('doc.docx')?.url).toBe('https://hook.test/file')
  })

  it('fireCallback dispatches comment.added to user-wide subscriber even when no per-file sub exists', async () => {
    const { saveCallbackForUser, fireCallback } = await loadStore()
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/org',
      events: ['comment.added', 'comment.resolved'],
      createdAt: Date.now(),
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('comment.added', 'some-file.docx', {
      commentId: 'cm_1',
      author: 'bob',
      text: 'review',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]!
    const body = JSON.parse(call[1]!.body as string)
    expect(body.event).toBe('comment.added')
    expect(body.fileId).toBe('some-file.docx')
    expect(body.userSub).toBe('alice@acme.com')
    expect(body.data.commentId).toBe('cm_1')
    expect(results).toHaveLength(1)
    expect(results[0]!.delivered).toBe(true)
    expect(results[0]!.url).toBe('https://hook.test/org')
  })

  it('fireCallback delivers to BOTH per-file AND user-wide recipients', async () => {
    const { saveCallback, saveCallbackForUser, fireCallback } = await loadStore()
    saveCallback({
      fileId: 'shared.docx',
      url: 'https://hook.test/file',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/org',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('file.saved', 'shared.docx', { path: '/x.docx' })
    expect(results).toHaveLength(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = results.map((r) => r.url).sort()
    expect(urls).toEqual(['https://hook.test/file', 'https://hook.test/org'])
  })

  it('fireCallback URL-dedupes when per-file and user-wide subs point at the same URL', async () => {
    const { saveCallback, saveCallbackForUser, fireCallback } = await loadStore()
    saveCallback({
      fileId: 'shared.docx',
      url: 'https://hook.test/shared',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/shared',
      events: ['file.saved'],
      createdAt: Date.now(),
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('file.saved', 'shared.docx', { path: '/x.docx' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(1)
    expect(results[0]!.url).toBe('https://hook.test/shared')
  })

  it('fireCallback user-wide subscriber ignores events not in its whitelist', async () => {
    const { saveCallbackForUser, fireCallback } = await loadStore()
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/org',
      events: ['ai.completed'], // deliberately omits comment.added
      createdAt: Date.now(),
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('comment.added', 'doc.docx', { commentId: 'cm_1' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.delivered).toBe(false)
    expect(results[0]!.attempts).toBe(0)
  })

  it('fireCallback returns [] when neither per-file nor user-wide subs exist', async () => {
    const { fireCallback } = await loadStore()
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('file.saved', 'nope.docx', { path: '/nope' })
    expect(results).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fireCallback fans out to multiple user-wide subscribers', async () => {
    const { saveCallbackForUser, fireCallback } = await loadStore()
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/alice',
      events: ['comment.added'],
      createdAt: Date.now(),
    })
    saveCallbackForUser('bob@acme.com', {
      url: 'https://hook.test/bob',
      events: ['comment.added'],
      createdAt: Date.now(),
    })
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback('comment.added', 'doc.docx', { commentId: 'cm_1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(results).toHaveLength(2)
    const urls = results.map((r) => r.url).sort()
    expect(urls).toEqual(['https://hook.test/alice', 'https://hook.test/bob'])
    for (const r of results) {
      const call = fetchMock.mock.calls.find((c) => c[0] === r.url)!
      const body = JSON.parse(call[1]!.body as string)
      expect(body.userSub).toBeDefined()
      expect(['alice@acme.com', 'bob@acme.com']).toContain(body.userSub)
    }
  })

  it('fireCallback on user-wide sub retries per-recipient (one failing does not short-circuit others)', async () => {
    const { saveCallbackForUser, fireCallback } = await loadStore()
    saveCallbackForUser('alice@acme.com', {
      url: 'https://hook.test/alice',
      events: ['comment.added'],
      createdAt: Date.now(),
    })
    saveCallbackForUser('bob@acme.com', {
      url: 'https://hook.test/bob',
      events: ['comment.added'],
      createdAt: Date.now(),
    })
    // alice: 503 always; bob: 200.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('alice')) return new Response('boom', { status: 503 })
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const results = await fireCallback(
      'comment.added',
      'doc.docx',
      { commentId: 'cm_1' },
      { maxAttempts: 2, initialBackoffMs: 0 },
    )
    expect(results).toHaveLength(2)
    const aliceResult = results.find((r) => r.url.includes('alice'))!
    const bobResult = results.find((r) => r.url.includes('bob'))!
    expect(aliceResult.delivered).toBe(false)
    expect(bobResult.delivered).toBe(true)
  })
})
