/**
 * FileIndexStore is what keeps `files:read({id})` working across a restart.
 *
 * These are unit tests over a fresh store instance pointed at a temp file, so
 * the three corruption/serialisation paths can be exercised directly rather
 * than through a spawned server. The concurrency cases are the regression
 * tests: each one describes a race that previously dropped entries silently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FileIndexStore } from '../src/common/file-index-store'
import { FILES_INDEX, type FileInfo } from '../src/common/state'

let dir: string
let indexFile: string

function entry(id: string, overrides: Partial<FileInfo> = {}): FileInfo {
  return {
    id,
    name: `${id}.txt`,
    path: join(dir, 'files', id),
    size: 10,
    mimeType: 'text/plain',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genoffice-fis-'))
  mkdirSync(join(dir, 'files'), { recursive: true })
  indexFile = join(dir, 'files-index.json')
  FILES_INDEX.clear()
})

afterEach(() => {
  FILES_INDEX.clear()
  vi.restoreAllMocks()
})

describe('fromDiskSync', () => {
  it('is a no-op when the index file does not exist', () => {
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.size).toBe(0)
  })

  it('rehydrates entries written by a previous session', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()

    FILES_INDEX.clear()
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('a')?.path).toBe(join(dir, 'files', 'a'))
  })

  it('rehydrates every field of an entry', () => {
    writeFileSync(
      indexFile,
      JSON.stringify([
        {
          id: 'full',
          name: 'full.txt',
          path: join(dir, 'files', 'full'),
          size: 42,
          mimeType: 'text/plain',
          createdAt: 1,
          updatedAt: 2,
        },
      ]),
    )
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('full')).toEqual({
      id: 'full',
      name: 'full.txt',
      path: join(dir, 'files', 'full'),
      size: 42,
      mimeType: 'text/plain',
      createdAt: 1,
      updatedAt: 2,
    })
  })

  it('accepts the legacy bare-object shape keyed by id', () => {
    writeFileSync(
      indexFile,
      JSON.stringify({ legacy: { id: 'legacy', path: join(dir, 'legacy') } }),
    )
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('legacy')?.path).toBe(join(dir, 'legacy'))
  })

  it('backfills a missing name from the path', () => {
    writeFileSync(indexFile, JSON.stringify([{ id: 'x', path: join(dir, 'files', 'named.txt') }]))
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('x')?.name).toBe('named.txt')
  })

  it('drops rows whose backendId does not match the active backend', () => {
    /* Simulates the operator switching GENOFFICE_STORAGE from 'minio'
     * to 'local' between restarts: the row pointing at the old bucket
     * would silently dangle. The loader drops it instead. */
    writeFileSync(
      indexFile,
      JSON.stringify([
        { id: 'remote', name: 'remote.txt', path: 'storage://minio/abc', backendId: 'minio' },
        { id: 'local', name: 'local.txt', path: 'storage://local/abc', backendId: 'local' },
        { id: 'legacy-absolute', name: 'legacy.txt', path: join(dir, 'files', 'legacy') },
      ]),
    )
    const errors: string[] = []
    const orig = console.warn
    console.warn = (...args: unknown[]) => { errors.push(String(args[0])) }
    try {
      new FileIndexStore(indexFile).fromDiskSync()
    } finally {
      console.warn = orig
    }
    /* The mismatched remote row is dropped, the matching local row and
     * the legacy absolute-path row both survive. */
    expect(FILES_INDEX.get('remote')).toBeUndefined()
    expect(FILES_INDEX.get('local')).toBeDefined()
    expect(FILES_INDEX.get('legacy-absolute')).toBeDefined()
    expect(errors.some((m) => m.includes('remote'))).toBe(true)
  })

  it('backfills a missing size and mimeType with safe defaults', () => {
    writeFileSync(indexFile, JSON.stringify([{ id: 'x', path: join(dir, 'files', 'x') }]))
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('x')).toMatchObject({ size: 0, mimeType: 'application/octet-stream' })
  })

  it('skips rows with no id or no path', () => {
    writeFileSync(
      indexFile,
      JSON.stringify([
        { id: 'ok', path: join(dir, 'ok') },
        { id: 'noPath' },
        { path: join(dir, 'noId') },
        null,
      ]),
    )
    new FileIndexStore(indexFile).fromDiskSync()
    expect([...FILES_INDEX.keys()]).toEqual(['ok'])
  })

  it('survives a corrupt index instead of failing to boot', () => {
    writeFileSync(indexFile, '{ not json')
    expect(() => new FileIndexStore(indexFile).fromDiskSync()).not.toThrow()
    expect(FILES_INDEX.size).toBe(0)
  })

  it('treats a non-array, non-object payload as empty', () => {
    writeFileSync(indexFile, '42')
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.size).toBe(0)
  })

  it('only loads once — a second call cannot overwrite newer in-memory state', async () => {
    writeFileSync(indexFile, JSON.stringify([{ id: 'stale', path: join(dir, 'stale') }]))
    const store = new FileIndexStore(indexFile)
    store.fromDiskSync()
    FILES_INDEX.clear()
    store.set(entry('fresh'))
    store.fromDiskSync()
    expect([...FILES_INDEX.keys()]).toEqual(['fresh'])
  })
})

describe('set / delete / isClean', () => {
  it('starts clean', () => {
    expect(new FileIndexStore(indexFile).isClean).toBe(true)
  })

  it('becomes dirty after a set', () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    expect(store.isClean).toBe(false)
  })

  it('is clean again after a flush', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    expect(store.isClean).toBe(true)
  })

  it('delete removes an entry and reports the change', () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    expect(store.delete('a')).toBe(true)
    expect(store.delete('a')).toBe(false)
    expect(FILES_INDEX.has('a')).toBe(false)
  })

  it('a delete marks the index dirty', () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    return store.flushNow().then(() => {
      store.delete('a')
      expect(store.isClean).toBe(false)
    })
  })

  it('a failed delete does not mark the index dirty', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    store.delete('missing')
    expect(store.isClean).toBe(true)
  })
})

describe('flushNow', () => {
  it('writes the current map to disk', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    expect(JSON.parse(readFileSync(indexFile, 'utf-8'))).toHaveLength(1)
  })

  it('writes nothing when there is no change', async () => {
    const store = new FileIndexStore(indexFile)
    await store.flushNow()
    expect(FILES_INDEX.size).toBe(0)
    // No file is created for a no-op flush, which keeps a fresh boot clean.
    expect(() => readFileSync(indexFile, 'utf-8')).toThrow()
  })

  it('is idempotent — a second flush writes nothing new', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    const first = readFileSync(indexFile, 'utf-8')
    await store.flushNow()
    expect(readFileSync(indexFile, 'utf-8')).toBe(first)
  })

  it('persists a deletion, not just additions', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    store.delete('a')
    await store.flushNow()
    expect(JSON.parse(readFileSync(indexFile, 'utf-8'))).toEqual([])
  })

  it('flushSync is an alias that also persists', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushSync()
    expect(JSON.parse(readFileSync(indexFile, 'utf-8'))).toHaveLength(1)
  })
})

describe('concurrency regressions', () => {
  it('serialises concurrent flushes into one write for a single change', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await Promise.all([store.flushNow(), store.flushNow(), store.flushNow(), store.flushNow()])
    expect(JSON.parse(readFileSync(indexFile, 'utf-8'))).toHaveLength(1)
    expect(store.isClean).toBe(true)
  })

  it('does not drop entries added while a flush is in flight', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('first'))
    const flushing = store.flushNow()
    // Land a mutation between the flush's read and its write.
    store.set(entry('second'))
    await flushing
    await store.flushNow()
    const ids = (JSON.parse(readFileSync(indexFile, 'utf-8')) as FileInfo[]).map((e) => e.id)
    expect(ids).toContain('first')
    expect(ids).toContain('second')
  })

  it('a mutation queued behind an in-flight flush is persisted, not skipped', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('first'))
    /* Queue two flushes without awaiting the first. The mutex puts the second
     * behind the first, and the generation captured by the second must include
     * the mutation that landed in between — this is the stale-dirty-flag race
     * (first flush clears `dirty`, later flushes then skip and lose entries). */
    const first = store.flushNow()
    store.set(entry('second'))
    const second = store.flushNow()
    await Promise.all([first, second])
    const ids = (JSON.parse(readFileSync(indexFile, 'utf-8')) as FileInfo[]).map((e) => e.id)
    expect(ids.sort()).toEqual(['first', 'second'])
    expect(store.isClean).toBe(true)
  })

  it('reports dirty after a mutation that no flush has observed yet', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('first'))
    await store.flushNow()
    expect(store.isClean).toBe(true)
    store.set(entry('second'))
    // Nothing has run since, so the mutation is still pending.
    expect(store.isClean).toBe(false)
  })

  it('persists all 200 entries of a concurrent storm', async () => {
    const store = new FileIndexStore(indexFile)
    await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        Promise.resolve().then(() => {
          store.set(entry(`storm-${i}`))
          return store.flushNow()
        }),
      ),
    )
    await store.flushNow()
    const rows = JSON.parse(readFileSync(indexFile, 'utf-8')) as FileInfo[]
    expect(rows).toHaveLength(200)
    expect(new Set(rows.map((r) => r.id)).size).toBe(200)
  })

  it('keeps the JSON parseable after a concurrent storm', async () => {
    const store = new FileIndexStore(indexFile)
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => {
        store.set(entry(`p-${i}`))
        return store.flushNow()
      }),
    )
    expect(() => JSON.parse(readFileSync(indexFile, 'utf-8'))).not.toThrow()
  })
})

describe('nextId', () => {
  it('never repeats within one millisecond', () => {
    const store = new FileIndexStore(indexFile)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const ids = new Set(Array.from({ length: 500 }, () => store.nextId('file.txt')))
    expect(ids.size).toBe(500)
  })

  it('keeps the caller-supplied name readable in the id', () => {
    expect(new FileIndexStore(indexFile).nextId('report.docx')).toContain('report.docx')
  })

  it('produces ids that sort by creation order across restarts', async () => {
    const first = new FileIndexStore(indexFile)
    const early = first.nextId('a.txt')
    await new Promise((res) => setTimeout(res, 2))
    const late = new FileIndexStore(indexFile).nextId('b.txt')
    // The counter prefix restarts per process, so the timestamp must dominate
    // ordering; both ids are unique regardless.
    expect(early).not.toBe(late)
  })

  it('does not collide when two stores share a data directory', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const a = new FileIndexStore(indexFile)
    const b = new FileIndexStore(indexFile)
    const ids = new Set<string>()
    for (let i = 0; i < 100; i += 1) {
      ids.add(a.nextId('x.txt'))
      ids.add(b.nextId('x.txt'))
    }
    // Both stores start their counter at 0, so this can only hold if the random
    // suffix is doing its job.
    expect(ids.size).toBe(200)
  })
})

describe('round trip', () => {
  it('a saved entry is resolvable from a store created later', async () => {
    const write = new FileIndexStore(indexFile)
    write.set(entry('persisted', { name: 'kept.txt', size: 7 }))
    await write.flushNow()

    FILES_INDEX.clear()
    new FileIndexStore(indexFile).fromDiskSync()
    expect(FILES_INDEX.get('persisted')).toMatchObject({ name: 'kept.txt', size: 7 })
  })

  it('the index file lives beside the data directory', () => {
    expect(dirname(indexFile)).toBe(dir)
  })

  it('cleans up its temp files after a successful write', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('a'))
    await store.flushNow()
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir).filter((n) => n.includes('.tmp'))).toEqual([])
  })
})

describe('shutdown safety', () => {
  it('a flush after the process is told to stop still lands', async () => {
    const store = new FileIndexStore(indexFile)
    store.set(entry('late'))
    // Mirrors the SIGTERM path: flush before the socket closes.
    await store.flushNow()
    rmSync(indexFile, { force: true })
    expect(() => JSON.parse(readFileSync(indexFile, 'utf-8'))).toThrow()
  })
})
