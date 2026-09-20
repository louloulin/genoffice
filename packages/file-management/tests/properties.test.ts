/**
 * File search and metadata.
 *
 * The behaviour a user notices is ranking (the file they typed the name of
 * comes first) and containment (internal state such as `.trash/` never shows
 * up in results). The walk is also bounded, which is what keeps the home
 * search box from freezing on a large tree.
 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileProperties, scoreMatch, searchFiles, sha256File } from '../src/properties'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'genoffice-props-'))
}

describe('scoreMatch', () => {
  it('scores an exact match highest', () => {
    expect(scoreMatch('report.docx', 'report.docx')).toBe(1)
  })

  it('scores a prefix match below exact', () => {
    expect(scoreMatch('report.docx', 'repo')).toBe(0.9)
  })

  it('scores a substring match below prefix', () => {
    expect(scoreMatch('my-report.docx', 'report')).toBe(0.7)
  })

  it('scores no match as 0', () => {
    expect(scoreMatch('report.docx', 'budget')).toBe(0)
  })

  it('is case-insensitive', () => {
    expect(scoreMatch('REPORT.DOCX', 'report')).toBe(0.9)
  })

  it('returns 0 for an empty needle rather than matching everything', () => {
    expect(scoreMatch('anything', '')).toBe(0)
  })
})

describe('searchFiles', () => {
  it('finds a file by an exact basename', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'budget.xlsx'), 'x')
    const hits = searchFiles(dir, 'budget.xlsx')
    expect(hits).toHaveLength(1)
    expect(hits[0].name).toBe('budget.xlsx')
  })

  it('ranks the exact match above a partial one', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'notes.txt'), 'a')
    writeFileSync(join(dir, 'my-notes-archive.txt'), 'b')
    expect(searchFiles(dir, 'notes.txt')[0].name).toBe('notes.txt')
  })

  it('recurses into subdirectories', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'deeper', 'buried.docx'), 'x')
    expect(searchFiles(dir, 'buried').map((h) => h.name)).toEqual(['buried.docx'])
  })

  it('never surfaces dot-directories such as .trash', () => {
    const dir = tempDir()
    mkdirSync(join(dir, '.trash'), { recursive: true })
    writeFileSync(join(dir, '.trash', 'deleted.txt'), 'x')
    writeFileSync(join(dir, '.hidden.txt'), 'x')
    expect(searchFiles(dir, '.txt')).toEqual([])
    expect(searchFiles(dir, 'deleted')).toEqual([])
    expect(searchFiles(dir, 'hidden')).toEqual([])
  })

  it('returns an empty list when nothing matches', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'a.txt'), 'x')
    expect(searchFiles(dir, 'zzz')).toEqual([])
  })

  it('returns an empty list for a missing root instead of throwing', () => {
    expect(searchFiles(join(tempDir(), 'does-not-exist'), 'x')).toEqual([])
  })

  it('carries size and mtime on each hit', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'sized.txt'), 'x'.repeat(42))
    const hit = searchFiles(dir, 'sized')[0]
    expect(hit.sizeBytes).toBe(42)
    expect(hit.mtimeMs).toBeGreaterThan(0)
  })

  it('reports an absolute path for each hit', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'abs.txt'), 'x')
    expect(searchFiles(dir, 'abs')[0].path).toBe(join(dir, 'abs.txt'))
  })

  it('honours a maxEntries cap so a huge tree cannot stall the request', () => {
    const dir = tempDir()
    for (let i = 0; i < 60; i += 1) writeFileSync(join(dir, `file-${i}.txt`), 'x')
    expect(searchFiles(dir, 'file-', { maxEntries: 10 }).length).toBeLessThanOrEqual(10)
  })

  it('honours a maxDepth cap', () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'a', 'b', 'c'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'c', 'deep.txt'), 'x')
    expect(searchFiles(dir, 'deep', { maxDepth: 1 })).toEqual([])
  })

  it('sorts equally-scored hits newest first', () => {
    const dir = tempDir()
    // Same basename in two directories: equal score, so mtime decides.
    mkdirSync(join(dir, 'one'))
    mkdirSync(join(dir, 'two'))
    writeFileSync(join(dir, 'one', 'same.txt'), 'older')
    writeFileSync(join(dir, 'two', 'same.txt'), 'newer')
    const hits = searchFiles(dir, 'same.txt')
    expect(hits).toHaveLength(2)
    expect(hits[0].mtimeMs).toBeGreaterThanOrEqual(hits[1].mtimeMs)
  })
})

describe('sha256File', () => {
  it('matches the digest of the same bytes computed with node:crypto', () => {
    const dir = tempDir()
    const file = join(dir, 'hash.txt')
    const payload = 'the quick brown fox'
    writeFileSync(file, payload)
    expect(sha256File(file)).toBe(createHash('sha256').update(payload).digest('hex'))
  })

  it('returns null for a missing file rather than throwing', () => {
    expect(sha256File(join(tempDir(), 'ghost.txt'))).toBeNull()
  })

  it('returns null for a directory', () => {
    expect(sha256File(tempDir())).toBeNull()
  })

  it('hashes a payload larger than one chunk correctly', () => {
    const dir = tempDir()
    const file = join(dir, 'big.bin')
    // 2.5 MiB crosses the 1 MiB chunk boundary twice.
    const payload = Buffer.alloc(2.5 * 1024 * 1024, 0x61)
    writeFileSync(file, payload)
    expect(sha256File(file)).toBe(createHash('sha256').update(payload).digest('hex'))
  })
})

describe('fileProperties', () => {
  it('reports size, name, and hash for a file', () => {
    const dir = tempDir()
    const file = join(dir, 'props.txt')
    writeFileSync(file, 'abc')
    const props = fileProperties(file)!
    expect(props).toMatchObject({
      path: file,
      name: 'props.txt',
      sizeBytes: 3,
      isDirectory: false,
    })
    expect(props.hash).toBe(createHash('sha256').update('abc').digest('hex'))
  })

  it('reports a directory without attempting a digest', () => {
    const dir = tempDir()
    const props = fileProperties(dir)!
    expect(props.isDirectory).toBe(true)
    expect(props.hash).toBeNull()
  })

  it('returns null for a missing path', () => {
    expect(fileProperties(join(tempDir(), 'ghost'))).toBeNull()
  })

  it('reports an mtime and a creation time', () => {
    const dir = tempDir()
    const file = join(dir, 'timed.txt')
    writeFileSync(file, 'x')
    const props = fileProperties(file)!
    expect(props.mtimeMs).toBeGreaterThan(0)
    expect(props.createdAtMs).toBeGreaterThan(0)
  })
})
