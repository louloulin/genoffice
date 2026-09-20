/**
 * Version history is the safety net under an overwrite.
 *
 * The behaviour that matters: a previous revision is still readable after a
 * save, pruning is per-document (a heavily-edited file must not evict the only
 * revision of every other file), and a restore does not destroy the version it
 * replaces.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VersionHistory } from '../src/version-history'

function setup(maxVersions = 20) {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-versions-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  let now = 1_700_000_000_000
  const versions = new VersionHistory(root, maxVersions, () => (now += 1000))
  return { root, files, versions, advance: (ms: number) => (now += ms) }
}

describe('VersionHistory', () => {
  it('starts with no revisions', () => {
    expect(setup().versions.list('/anything')).toEqual([])
  })

  it('snapshots the current bytes of a document', () => {
    const { files, versions } = setup()
    const doc = join(files, 'report.docx')
    writeFileSync(doc, 'v1')
    const entry = versions.snapshot(doc)!
    expect(versions.read(entry.id)!.toString('utf-8')).toBe('v1')
  })

  it('records the size and path of the document', () => {
    const { files, versions } = setup()
    const doc = join(files, 'sized.docx')
    writeFileSync(doc, 'x'.repeat(50))
    const entry = versions.snapshot(doc)!
    expect(entry).toMatchObject({ path: doc, sizeBytes: 50 })
  })

  it('stores an optional label', () => {
    const { files, versions } = setup()
    const doc = join(files, 'labelled.docx')
    writeFileSync(doc, 'v1')
    expect(versions.snapshot(doc, 'autosave')!.label).toBe('autosave')
  })

  it('omits the label key entirely when none is given', () => {
    const { files, versions } = setup()
    const doc = join(files, 'unlabelled.docx')
    writeFileSync(doc, 'v1')
    expect(versions.snapshot(doc)).not.toHaveProperty('label')
  })

  it('returns null for a missing file instead of throwing', () => {
    const { versions, files } = setup()
    expect(versions.snapshot(join(files, 'ghost.docx'))).toBeNull()
  })

  it('refuses to snapshot a 0-byte file (it would overwrite a good revision)', () => {
    const { files, versions } = setup()
    const doc = join(files, 'empty.docx')
    writeFileSync(doc, '')
    expect(versions.snapshot(doc)).toBeNull()
  })

  it('keeps several revisions of the same document, newest first', () => {
    const { files, versions } = setup()
    const doc = join(files, 'multi.docx')
    writeFileSync(doc, 'v1')
    versions.snapshot(doc)
    writeFileSync(doc, 'v2')
    versions.snapshot(doc)
    writeFileSync(doc, 'v3')
    versions.snapshot(doc)
    expect(versions.list(doc)).toHaveLength(3)
    expect(versions.read(versions.list(doc)[0].id)!.toString('utf-8')).toBe('v3')
  })

  it('scopes list() to one document', () => {
    const { files, versions } = setup()
    const a = join(files, 'a.docx')
    const b = join(files, 'b.docx')
    writeFileSync(a, 'a')
    writeFileSync(b, 'b')
    versions.snapshot(a)
    versions.snapshot(b)
    expect(versions.list(a)).toHaveLength(1)
    expect(versions.list(b)).toHaveLength(1)
  })

  it('prunes per document rather than globally', () => {
    const { files, versions } = setup(2)
    const busy = join(files, 'busy.docx')
    const quiet = join(files, 'quiet.docx')
    writeFileSync(quiet, 'quiet-v1')
    versions.snapshot(quiet)
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(busy, `busy-v${i}`)
      versions.snapshot(busy)
    }
    // The busy document churned five times but must not have evicted the
    // quiet document's only revision.
    expect(versions.list(busy)).toHaveLength(2)
    expect(versions.list(quiet)).toHaveLength(1)
  })

  it('drops the payload of a pruned revision from disk', () => {
    const { files, versions } = setup(1)
    const doc = join(files, 'pruned.docx')
    writeFileSync(doc, 'v1')
    const first = versions.snapshot(doc)!
    writeFileSync(doc, 'v2')
    versions.snapshot(doc)
    expect(versions.read(first.id)).toBeNull()
  })

  it('read() returns null for an unknown id', () => {
    expect(setup().versions.read('no-such-id')).toBeNull()
  })

  it('restores a document to a previous revision', () => {
    const { files, versions } = setup()
    const doc = join(files, 'restore.docx')
    writeFileSync(doc, 'good version')
    const entry = versions.snapshot(doc)!
    writeFileSync(doc, 'bad version')
    expect(versions.restore(entry.id)).toEqual({ ok: true, path: doc })
    expect(readFileSync(doc, 'utf-8')).toBe('good version')
  })

  it('snapshots the current bytes before restoring, so a restore is undoable', () => {
    const { files, versions } = setup()
    const doc = join(files, 'undoable.docx')
    writeFileSync(doc, 'v1')
    const first = versions.snapshot(doc)!
    writeFileSync(doc, 'v2')
    versions.restore(first.id)
    const labels = versions.list(doc).map((e) => e.label)
    expect(labels).toContain('pre-restore')
  })

  it('reports an unknown version rather than writing anywhere', () => {
    expect(setup().versions.restore('nope')).toEqual({ ok: false, error: 'version not found' })
  })

  it('reports a version whose payload vanished', () => {
    const { files, versions } = setup()
    const doc = join(files, 'vanish.docx')
    writeFileSync(doc, 'v1')
    const entry = versions.snapshot(doc)!
    rmSync(join((versions as unknown as { dir: string }).dir, entry.storedName), { force: true })
    expect(versions.restore(entry.id)).toEqual({ ok: false, error: 'version payload is missing' })
  })

  it('recreates a missing document path on restore', () => {
    const { files, versions } = setup()
    const doc = join(files, 'recreated.docx')
    writeFileSync(doc, 'content')
    const entry = versions.snapshot(doc)!
    rmSync(doc, { force: true })
    expect(versions.restore(entry.id)).toEqual({ ok: true, path: doc })
    expect(existsSync(doc)).toBe(true)
  })

  it('reports total bytes held by stored revisions', () => {
    const { files, versions } = setup()
    const doc = join(files, 'usage.docx')
    writeFileSync(doc, 'x'.repeat(100))
    versions.snapshot(doc)
    const usage = versions.usageBytes()
    expect(usage).toBeGreaterThanOrEqual(100)
  })

  it('reports zero usage when nothing has been snapshotted', () => {
    expect(setup().versions.usageBytes()).toBe(0)
  })

  it('recovers from a corrupt index instead of throwing', () => {
    const { root, files, versions } = setup()
    const doc = join(files, 'x.docx')
    writeFileSync(doc, 'v1')
    versions.snapshot(doc)
    writeFileSync(join(root, 'versions', 'index.json'), '{ not json')
    expect(versions.list(doc)).toEqual([])
  })

  it('gives every revision a distinct id even within one millisecond', () => {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-versions-'))
    const files = join(root, 'files')
    mkdirSync(files, { recursive: true })
    // A frozen clock is the worst case for id collisions.
    const versions = new VersionHistory(root, 20, () => 1_700_000_000_000)
    const doc = join(files, 'burst.docx')
    const ids = new Set<string>()
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(doc, `v${i}`)
      ids.add(versions.snapshot(doc)!.id)
    }
    expect(ids.size).toBe(20)
  })
})
