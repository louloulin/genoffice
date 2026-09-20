/**
 * Trash makes the home-grid delete recoverable.
 *
 * The two properties that protect the user: a deleted file's bytes are still
 * there, and restoring never overwrites something newer that took the
 * original path in the meantime.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Trash } from '../src/trash'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-trash-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  return { root, files, trash: new Trash(root) }
}

describe('Trash', () => {
  it('starts empty', () => {
    expect(setup().trash.list()).toEqual([])
  })

  it('moves the file out of its original location', () => {
    const { files, trash } = setup()
    const source = join(files, 'doomed.docx')
    writeFileSync(source, 'bytes')
    trash.delete(source)
    expect(existsSync(source)).toBe(false)
  })

  it('keeps the payload bytes recoverable', () => {
    const { files, trash } = setup()
    const source = join(files, 'doomed.docx')
    writeFileSync(source, 'the real bytes')
    trash.delete(source)
    const stored = trash.storedNames()
    expect(stored).toHaveLength(1)
    expect(readFileSync(join((trash as unknown as { dir: string }).dir, stored[0]), 'utf-8')).toBe(
      'the real bytes',
    )
  })

  it('records the original path, name, and size', () => {
    const { files, trash } = setup()
    const source = join(files, 'report.pdf')
    writeFileSync(source, 'x'.repeat(123))
    const entry = trash.delete(source)
    expect(entry).toMatchObject({ originalPath: source, name: 'report.pdf', sizeBytes: 123 })
  })

  it('surfaces the deleted entry through list()', () => {
    const { files, trash } = setup()
    const source = join(files, 'a.txt')
    writeFileSync(source, 'a')
    trash.delete(source)
    expect(trash.list().map((e) => e.originalPath)).toEqual([source])
  })

  it('returns null when the file is already gone instead of throwing', () => {
    const { trash } = setup()
    expect(trash.delete(join(setup().root, 'ghost.txt'))).toBeNull()
  })

  it('refuses to trashing a directory', () => {
    const { files, trash } = setup()
    const dir = join(files, 'folder')
    mkdirSync(dir)
    expect(trash.delete(dir)).toBeNull()
  })

  it('keeps two same-named files from different directories separate', () => {
    const { files, trash } = setup()
    const first = join(files, 'one.txt')
    const second = join(files, 'sub', 'one.txt')
    mkdirSync(join(files, 'sub'))
    writeFileSync(first, 'first')
    writeFileSync(second, 'second')
    trash.delete(first)
    trash.delete(second)
    expect(trash.list()).toHaveLength(2)
    expect(trash.storedNames()).toHaveLength(2)
  })

  it('orders the list newest-first', () => {
    let now = 1000
    const root = mkdtempSync(join(tmpdir(), 'genoffice-trash-'))
    const files = join(root, 'files')
    mkdirSync(files, { recursive: true })
    const trash = new Trash(root, () => now)
    writeFileSync(join(files, 'old.txt'), 'o')
    trash.delete(join(files, 'old.txt'))
    now = 2000
    writeFileSync(join(files, 'new.txt'), 'n')
    trash.delete(join(files, 'new.txt'))
    expect(trash.list().map((e) => e.name)).toEqual(['new.txt', 'old.txt'])
  })

  it('restores a file to its original path', () => {
    const { files, trash } = setup()
    const source = join(files, 'restore-me.txt')
    writeFileSync(source, 'payload')
    const entry = trash.delete(source)!
    const result = trash.restore(entry.id)
    expect(result).toEqual({ ok: true, path: source })
    expect(readFileSync(source, 'utf-8')).toBe('payload')
  })

  it('removes the entry from the list after a restore', () => {
    const { files, trash } = setup()
    const source = join(files, 'restore-me.txt')
    writeFileSync(source, 'payload')
    const entry = trash.delete(source)!
    trash.restore(entry.id)
    expect(trash.list()).toEqual([])
  })

  it('recreates a missing parent directory on restore', () => {
    const { files, trash } = setup()
    const source = join(files, 'nested', 'deep.txt')
    mkdirSync(join(files, 'nested'))
    writeFileSync(source, 'deep')
    const entry = trash.delete(source)!
    /* The user may also have removed the now-empty folder; restore must still
     * land the file back where it was instead of failing with ENOENT. */
    rmSync(join(files, 'nested'), { recursive: true, force: true })
    expect(trash.restore(entry.id)).toEqual({ ok: true, path: source })
    expect(readFileSync(source, 'utf-8')).toBe('deep')
  })

  it('refuses to restore when the original path is occupied', () => {
    const { files, trash } = setup()
    const source = join(files, 'contested.txt')
    writeFileSync(source, 'the old one')
    const entry = trash.delete(source)!
    writeFileSync(source, 'a newer file')
    const result = trash.restore(entry.id)
    expect(result).toEqual({ ok: false, error: 'original path is occupied' })
    // The critical assertion: the newer file was not destroyed.
    expect(readFileSync(source, 'utf-8')).toBe('a newer file')
  })

  it('reports an unknown id rather than writing anywhere', () => {
    const { trash } = setup()
    expect(trash.restore('no-such-id')).toEqual({ ok: false, error: 'trash entry not found' })
  })

  it('drops a stale index row whose payload disappeared', () => {
    const { files, trash } = setup()
    const source = join(files, 'vanish.txt')
    writeFileSync(source, 'x')
    const entry = trash.delete(source)!
    rmSync(source, { force: true })
    rmSync(join((trash as unknown as { dir: string }).dir, trash.storedNames()[0]), { force: true })
    expect(trash.restore(entry.id)).toEqual({ ok: false, error: 'trashed file is missing' })
    expect(trash.list()).toEqual([])
  })

  it('has() reports whether a path is in the trash', () => {
    const { files, trash } = setup()
    const source = join(files, 'check.txt')
    writeFileSync(source, 'x')
    expect(trash.has(source)).toBe(false)
    trash.delete(source)
    expect(trash.has(source)).toBe(true)
  })

  it('purge drops the entry and its payload permanently', () => {
    const { files, trash } = setup()
    const source = join(files, 'purge-me.txt')
    writeFileSync(source, 'x')
    const entry = trash.delete(source)!
    expect(trash.purge(entry.id)).toBe(true)
    expect(trash.list()).toEqual([])
    expect(trash.storedNames()).toEqual([])
  })

  it('purge reports false for an unknown id', () => {
    expect(setup().trash.purge('nope')).toBe(false)
  })

  it('ignores a corrupt index rather than booting into a bad state', () => {
    const { root, trash } = setup()
    mkdirSync(join(root, '.trash'), { recursive: true })
    writeFileSync(join(root, '.trash', 'index.json'), '{ not json')
    expect(trash.list()).toEqual([])
  })

  it('ignores index rows missing required fields', () => {
    const { root, trash } = setup()
    mkdirSync(join(root, '.trash'), { recursive: true })
    writeFileSync(join(root, '.trash', 'index.json'), JSON.stringify([{ id: 'a' }, null, 'x']))
    expect(trash.list()).toEqual([])
  })

  it('storedNames excludes the index itself', () => {
    const { files, trash } = setup()
    writeFileSync(join(files, 'a.txt'), 'a')
    trash.delete(join(files, 'a.txt'))
    expect(trash.storedNames()).not.toContain('index.json')
  })

  it('storedNames is empty when the trash directory does not exist yet', () => {
    expect(setup().trash.storedNames()).toEqual([])
  })
})
