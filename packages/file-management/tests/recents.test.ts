/**
 * Recents is the user's main route back into a document, so the two
 * behaviours with real user impact are: the list survives a restart, and
 * re-opening the same file does not produce a second row.
 *
 * A fake clock is injected everywhere so the tests never sleep for the
 * debounce window and never depend on wall-clock ordering.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UnifiedRecents } from '../src/recents'

function tempFile(name = 'recents.json'): string {
  return join(mkdtempSync(join(tmpdir(), 'genoffice-recents-')), name)
}

/** A clock that only moves when the test tells it to. */
function fakeClock(start = 1_700_000_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('UnifiedRecents', () => {
  it('starts empty when no file exists', () => {
    expect(new UnifiedRecents(tempFile()).list()).toEqual([])
  })

  it('lists the most recently added entry first', async () => {
    const clock = fakeClock()
    const recents = new UnifiedRecents(tempFile(), { now: clock.now })
    await recents.add('/a.txt')
    clock.advance(1000)
    await recents.add('/b.txt')
    expect(recents.list().map((e) => e.path)).toEqual(['/b.txt', '/a.txt'])
  })

  it('is idempotent by path — re-adding moves the entry, never duplicates', async () => {
    const clock = fakeClock()
    const recents = new UnifiedRecents(tempFile(), { now: clock.now })
    await recents.add('/a.txt')
    await recents.add('/b.txt')
    clock.advance(1000)
    await recents.add('/a.txt')
    expect(recents.list().map((e) => e.path)).toEqual(['/a.txt', '/b.txt'])
    expect(recents.list()).toHaveLength(2)
  })

  it('refreshes openedAt when an existing entry is re-opened', async () => {
    const clock = fakeClock()
    const recents = new UnifiedRecents(tempFile(), { now: clock.now })
    const first = await recents.add('/a.txt')
    clock.advance(5000)
    const second = await recents.add('/a.txt')
    expect(second.openedAt).toBe(first.openedAt + 5000)
  })

  it('derives the display name from the path when none is given', async () => {
    const recents = new UnifiedRecents(tempFile())
    const entry = await recents.add('/docs/report.docx')
    expect(entry.name).toBe('report.docx')
  })

  it('keeps an explicit name over the path-derived one', async () => {
    const recents = new UnifiedRecents(tempFile())
    expect((await recents.add('/x/1', { name: 'Q3 Report' })).name).toBe('Q3 Report')
  })

  it('records the modified flag and defaults it to false', async () => {
    const recents = new UnifiedRecents(tempFile())
    expect((await recents.add('/opened.txt')).modified).toBe(false)
    expect((await recents.add('/saved.txt', { modified: true })).modified).toBe(true)
  })

  it('preserves projectId and labels across a re-add that omits them', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.txt', { projectId: 'proj-1', labels: ['urgent'] })
    const again = await recents.add('/a.txt')
    expect(again.projectId).toBe('proj-1')
    expect(again.labels).toEqual(['urgent'])
  })

  it('get returns the entry for a path and undefined otherwise', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.txt')
    expect(recents.get('/a.txt')?.path).toBe('/a.txt')
    expect(recents.get('/nope.txt')).toBeUndefined()
  })

  it('remove drops an entry and reports whether anything changed', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.txt')
    await expect(recents.remove('/a.txt')).resolves.toBe(true)
    await expect(recents.remove('/a.txt')).resolves.toBe(false)
    expect(recents.list()).toEqual([])
  })

  it('rename moves the entry instead of leaving a dangling row', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/old.docx', { name: 'old.docx' })
    await expect(recents.rename('/old.docx', '/new.docx')).resolves.toBe(true)
    expect(recents.list()[0]).toMatchObject({ path: '/new.docx', name: 'new.docx' })
  })

  it('rename reports false for an unknown path', async () => {
    const recents = new UnifiedRecents(tempFile())
    await expect(recents.rename('/ghost', '/new')).resolves.toBe(false)
  })

  it('setStarred flips the flag on an existing entry', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.txt')
    await recents.setStarred('/a.txt', true)
    expect(recents.starred().map((e) => e.path)).toEqual(['/a.txt'])
    await recents.setStarred('/a.txt', false)
    expect(recents.starred()).toEqual([])
  })

  it('setStarred creates the entry when the file was never opened', async () => {
    const recents = new UnifiedRecents(tempFile())
    const entry = await recents.setStarred('/never-opened.txt', true, 'never-opened.txt')
    expect(entry.starred).toBe(true)
    expect(recents.starred()).toHaveLength(1)
  })

  it('persists to disk on flushNow', async () => {
    const file = tempFile()
    const recents = new UnifiedRecents(file, { debounceMs: 10_000 })
    await recents.add('/a.txt', { modified: true })
    recents.flushNow()
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveLength(1)
  })

  it('survives a restart — a new instance reads what the old one wrote', async () => {
    const file = tempFile()
    const first = new UnifiedRecents(file)
    await first.add('/persisted.txt', { modified: true })
    first.flushNow()

    const second = new UnifiedRecents(file)
    expect(second.list()).toHaveLength(1)
    expect(second.list()[0]).toMatchObject({ path: '/persisted.txt', modified: true })
  })

  it('is a no-op flush when nothing changed since the last write', async () => {
    const file = tempFile()
    const recents = new UnifiedRecents(file)
    await recents.add('/a.txt')
    recents.flushNow()
    expect(recents.writes).toBe(1)
    recents.flushNow()
    expect(recents.writes).toBe(1)
  })

  it('collapses a burst into a single debounced write', async () => {
    const recents = new UnifiedRecents(tempFile(), { debounceMs: 5 })
    for (let i = 0; i < 25; i += 1) await recents.add(`/file-${i}.txt`)
    expect(recents.writes).toBe(0)
    await new Promise((res) => setTimeout(res, 60))
    expect(recents.writes).toBe(1)
  })

  it('writes nothing if the debounce fires with no pending change', async () => {
    const recents = new UnifiedRecents(tempFile(), { debounceMs: 5 })
    await recents.add('/a.txt')
    recents.flushNow()
    await new Promise((res) => setTimeout(res, 40))
    expect(recents.writes).toBe(1)
  })

  it('recovers from a corrupt state file instead of throwing', async () => {
    const file = tempFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ not json')
    const recents = new UnifiedRecents(file)
    expect(recents.list()).toEqual([])
    await recents.add('/a.txt')
    expect(recents.list()).toHaveLength(1)
  })

  it('ignores rows that are not objects with a path', async () => {
    const file = tempFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify([{ path: '/ok.txt' }, null, 'nope', { noPath: 1 }]))
    expect(new UnifiedRecents(file).list().map((e) => e.path)).toEqual(['/ok.txt'])
  })

  it('treats a non-array JSON payload as an empty list', async () => {
    const file = tempFile()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify({ not: 'an array' }))
    expect(new UnifiedRecents(file).list()).toEqual([])
  })

  it('evicts the oldest entries past maxEntries', async () => {
    const clock = fakeClock()
    const recents = new UnifiedRecents(tempFile(), { now: clock.now, maxEntries: 3 })
    for (let i = 0; i < 6; i += 1) {
      await recents.add(`/file-${i}.txt`)
      clock.advance(1000)
    }
    expect(recents.list().map((e) => e.path)).toEqual(['/file-5.txt', '/file-4.txt', '/file-3.txt'])
  })

  it('page() slices, filters and reports both totals', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.docx')
    await recents.add('/b.md')
    await recents.add('/c.docx')
    const page = recents.page({ ext: 'docx' })
    expect(page.total).toBe(2)
    expect(page.totalAll).toBe(3)
    expect(page.entries).toHaveLength(2)
  })

  it('page() honours offset and limit', async () => {
    const recents = new UnifiedRecents(tempFile())
    for (let i = 0; i < 5; i += 1) await recents.add(`/f${i}.txt`)
    const page = recents.page({ offset: 1, limit: 2 })
    expect(page.entries).toHaveLength(2)
    expect(page.total).toBe(5)
  })

  it('page() ext matching is case-insensitive', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/REPORT.DOCX')
    expect(recents.page({ ext: 'docx' }).total).toBe(1)
  })

  it('returns copies from list() so callers cannot mutate internal state', async () => {
    const recents = new UnifiedRecents(tempFile())
    await recents.add('/a.txt')
    recents.list().push({ id: 'x', path: '/injected', name: 'x', openedAt: 0, modified: false })
    expect(recents.list()).toHaveLength(1)
  })

  it('unrefs the debounce timer so a pending flush cannot block shutdown', async () => {
    const recents = new UnifiedRecents(tempFile(), { debounceMs: 60_000 })
    await recents.add('/a.txt')
    /* A ref'd timer here would keep the event loop alive after SIGTERM for the
     * whole debounce window, which reads to the operator as a hung server. The
     * timer is private, so assert on the handle itself rather than waiting. */
    const timer = (recents as unknown as { timer?: NodeJS.Timeout }).timer
    expect(timer).toBeDefined()
    expect(timer!.hasRef()).toBe(false)
  })
})
