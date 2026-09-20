/**
 * Save-location history backs the "recent folders" list in Save As.
 *
 * The ranking rule is the whole point of the module: use count dominates and
 * recency breaks ties, so a directory the user works in daily stays reachable
 * instead of being pushed out by one-off visits.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SaveLocations } from '../src/save-locations'

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'genoffice-saveloc-')), 'save-locations.json')
}

function fakeClock(start = 1_700_000_000_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('SaveLocations', () => {
  it('starts empty', () => {
    expect(new SaveLocations(tempFile()).list()).toEqual([])
  })

  it('records a directory with uses = 1', () => {
    const locs = new SaveLocations(tempFile())
    expect(locs.record('/Users/me/Documents')).toMatchObject({
      path: '/Users/me/Documents',
      uses: 1,
    })
  })

  it('increments the use count on a repeat save', () => {
    const locs = new SaveLocations(tempFile())
    locs.record('/a')
    locs.record('/a')
    locs.record('/a')
    expect(locs.list()).toEqual([{ path: '/a', uses: 3, lastUsedAt: expect.any(Number) }])
  })

  it('does not create a second row for the same directory', () => {
    const locs = new SaveLocations(tempFile())
    locs.record('/a')
    locs.record('/a')
    expect(locs.list()).toHaveLength(1)
  })

  it('ranks by use count above recency', () => {
    const clock = fakeClock()
    const locs = new SaveLocations(tempFile(), clock.now)
    locs.record('/frequent')
    locs.record('/frequent')
    locs.record('/frequent')
    clock.advance(60_000)
    locs.record('/one-off')
    // The one-off is the most recent but the frequent dir must still win.
    expect(locs.list().map((l) => l.path)).toEqual(['/frequent', '/one-off'])
  })

  it('breaks a use-count tie by recency', () => {
    const clock = fakeClock()
    const locs = new SaveLocations(tempFile(), clock.now)
    locs.record('/older')
    clock.advance(1000)
    locs.record('/newer')
    expect(locs.list().map((l) => l.path)).toEqual(['/newer', '/older'])
  })

  it('forget removes a directory and reports the change', () => {
    const locs = new SaveLocations(tempFile())
    locs.record('/a')
    expect(locs.forget('/a')).toBe(true)
    expect(locs.forget('/a')).toBe(false)
    expect(locs.list()).toEqual([])
  })

  it('persists every record eagerly so a crash cannot lose the list', () => {
    const file = tempFile()
    const locs = new SaveLocations(file)
    locs.record('/a')
    // No flush call anywhere: record() is deliberately write-through.
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveLength(1)
  })

  it('reloads the list from disk', () => {
    const file = tempFile()
    new SaveLocations(file).record('/persisted')
    expect(new SaveLocations(file).list().map((l) => l.path)).toEqual(['/persisted'])
  })

  it('caps the list at maxEntries, dropping the oldest insertions', () => {
    const clock = fakeClock()
    const locs = new SaveLocations(tempFile(), clock.now, 3)
    for (let i = 0; i < 6; i += 1) {
      locs.record(`/dir-${i}`)
      clock.advance(1000)
    }
    const paths = locs.list().map((l) => l.path)
    expect(paths).toHaveLength(3)
    expect(paths).not.toContain('/dir-0')
  })

  it('recovers from a corrupt file instead of throwing', () => {
    const file = tempFile()
    writeFileSync(file, '{ not json')
    expect(new SaveLocations(file).list()).toEqual([])
  })

  it('ignores rows without a path', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify([{ path: '/ok' }, null, { uses: 2 }]))
    expect(new SaveLocations(file).list().map((l) => l.path)).toEqual(['/ok'])
  })

  it('treats a non-array payload as empty', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ path: '/a' }))
    expect(new SaveLocations(file).list()).toEqual([])
  })
})
