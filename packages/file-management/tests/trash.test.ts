/**
 * Trash makes the home-grid delete recoverable.
 *
 * The two properties that protect the user: a deleted file's bytes are still
 * there, and restoring never overwrites something newer that took the
 * original key in the meantime. The class now supports both filesystem-only
 * usage (no backend) and storage-backend usage (MinIO/S3/rustfs) — the
 * second branch is what makes remote-backed documents restorable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Trash, LOCAL_TRASH_DIR } from '../src/trash'

function setupFilesystem() {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-trash-'))
  const files = join(root, 'files')
  mkdirSync(files, { recursive: true })
  return { root, files, trash: new Trash(root, null) }
}

describe('Trash (filesystem only, legacy mode)', () => {
  it('starts empty', async () => {
    const { trash } = setupFilesystem()
    expect(await trash.list()).toEqual([])
  })

  it('moves the file out of its original location', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'doomed.docx')
    writeFileSync(source, 'bytes')
    await trash.delete(source)
    expect(existsSync(source)).toBe(false)
  })

  it('keeps the payload bytes recoverable', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'doomed.docx')
    writeFileSync(source, 'the real bytes')
    await trash.delete(source)
    const stored = await trash.storedKeys()
    expect(stored).toHaveLength(1)
    /* Read the payload through the filesystem directly (legacy mode). */
    expect(readFileSync(join(files, '..', '.trash', stored[0]), 'utf-8')).toBe('the real bytes')
  })

  it('records the original path, name, and size', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'report.pdf')
    writeFileSync(source, 'x'.repeat(123))
    const entry = await trash.delete(source)
    expect(entry).toMatchObject({
      originalKey: source,
      name: 'report.pdf',
      sizeBytes: 123,
      backendId: 'local',
    })
  })

  it('surfaces the deleted entry through list()', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'a.txt')
    writeFileSync(source, 'a')
    await trash.delete(source)
    expect((await trash.list()).map((e) => e.originalKey)).toEqual([source])
  })

  it('restore() returns the file to its original path', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'come-back.docx')
    writeFileSync(source, 'still here')
    const entry = await trash.delete(source)
    expect(entry).not.toBeNull()
    const result = await trash.restore(entry!.id)
    expect(result).toEqual({ ok: true, key: source })
    expect(existsSync(source)).toBe(true)
    expect(readFileSync(source, 'utf-8')).toBe('still here')
  })

  it('restore() refuses to overwrite a file that took the name in the meantime', async () => {
    const { files, trash } = setupFilesystem()
    const source = join(files, 'taken.txt')
    writeFileSync(source, 'old')
    const entry = await trash.delete(source)
    writeFileSync(source, 'new')
    const result = await trash.restore(entry!.id)
    expect(result.ok).toBe(false)
    /* The newer file at the original path survives. */
    expect(readFileSync(source, 'utf-8')).toBe('new')
  })

  it('delete() returns null for a missing file (idempotent)', async () => {
    const { files, trash } = setupFilesystem()
    expect(await trash.delete(join(files, 'ghost.txt'))).toBeNull()
  })

  it('delete() refuses directories', async () => {
    const { files, trash } = setupFilesystem()
    mkdirSync(join(files, 'dir'))
    expect(await trash.delete(join(files, 'dir'))).toBeNull()
  })

  it('survives many deletes (no key collisions in the trash)', async () => {
    const { files, trash } = setupFilesystem()
    writeFileSync(join(files, 'one.txt'), '1')
    writeFileSync(join(files, 'two.txt'), '2')
    await trash.delete(join(files, 'one.txt'))
    await trash.delete(join(files, 'two.txt'))
    expect(await trash.list()).toHaveLength(2)
    expect(await trash.storedKeys()).toHaveLength(2)
  })

  it('purge() permanently drops the entry', async () => {
    const { files, trash } = setupFilesystem()
    writeFileSync(join(files, 'gone.docx'), 'x')
    const entry = await trash.delete(join(files, 'gone.docx'))
    expect(await trash.purge(entry!.id)).toBe(true)
    expect(await trash.list()).toEqual([])
  })

  it('persists across instances (the index is on disk)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genoffice-trash-persist-'))
    const files = join(root, 'files')
    mkdirSync(files, { recursive: true })
    writeFileSync(join(files, 'x.txt'), 'x')
    const first = new Trash(root, null)
    await first.delete(join(files, 'x.txt'))
    /* New instance reads the same index file. */
    const second = new Trash(root, null)
    expect(await second.list()).toHaveLength(1)
    rmSync(root, { recursive: true, force: true })
  })
})

/**
 * Minimal in-memory backend that supports hierarchical keys (slashes). Stands
 * in for a remote S3/MinIO server so the storage-mode Trash routing can be
 * exercised without booting a real bucket. Mirrors just enough of the
 * StorageBackend surface that {@link Trash} routes through it.
 */
class MemoryBackend {
  readonly id = 'memory' as const
  private store = new Map<string, Buffer>()
  async get(key: string): Promise<Uint8Array> {
    const v = this.store.get(key)
    if (!v) throw new Error(`not found: ${key}`)
    return new Uint8Array(v)
  }
  async head(key: string) {
    const v = this.store.get(key)
    return v ? { exists: true, size: v.byteLength } : { exists: false, size: 0 }
  }
  async exists(key: string): Promise<boolean> {
    return this.store.has(key)
  }
  async put(key: string, bytes: Uint8Array) {
    this.store.set(key, Buffer.from(bytes))
    return { key, size: bytes.byteLength }
  }
  async delete(key: string) {
    this.store.delete(key)
  }
  async list(prefix = '') {
    const out: Array<{ key: string; size: number }> = []
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix)) out.push({ key: k, size: v.byteLength })
    }
    return out
  }
  async getSignedUrl(key: string) {
    return `memory://${key}`
  }
}

describe('Trash (storage backend mode)', () => {
  let root: string
  let backend: MemoryBackend
  let trash: Trash

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genoffice-trash-backend-'))
    backend = new MemoryBackend()
    trash = new Trash(root, backend as any)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('moves a key from the primary namespace into the trash namespace', async () => {
    await backend.put('doc.pdf', new TextEncoder().encode('payload bytes'))
    const result = await trash.delete('doc.pdf')
    expect(result).not.toBeNull()
    expect(await backend.exists('doc.pdf')).toBe(false)
    const stored = await backend.list(`${LOCAL_TRASH_DIR}/`)
    /* Payload sits in the trash namespace under a unique storedKey. */
    expect(stored.some((e) => e.key.includes('doc.pdf'))).toBe(true)
  })

  it('restore() returns the bytes to their original key', async () => {
    await backend.put('round-trip.docx', new TextEncoder().encode('round trip'))
    const entry = await trash.delete('round-trip.docx')
    const result = await trash.restore(entry!.id)
    expect(result).toEqual({ ok: true, key: 'round-trip.docx' })
    const bytes = await backend.get('round-trip.docx')
    expect(Buffer.from(bytes).toString('utf-8')).toBe('round trip')
  })

  it('restore() refuses when the original key is occupied', async () => {
    await backend.put('occupied.docx', new TextEncoder().encode('a'))
    const entry = await trash.delete('occupied.docx')
    /* Something else landed on the same key while the file was in the trash. */
    await backend.put('occupied.docx', new TextEncoder().encode('b'))
    const result = await trash.restore(entry!.id)
    expect(result.ok).toBe(false)
    /* The newer occupant wins. */
    const bytes = await backend.get('occupied.docx')
    expect(Buffer.from(bytes).toString('utf-8')).toBe('b')
  })

  it('purge() removes the payload from the backend', async () => {
    await backend.put('gone.bin', new TextEncoder().encode('x'))
    const entry = await trash.delete('gone.bin')
    expect(await trash.purge(entry!.id)).toBe(true)
    expect(await backend.exists('gone.bin')).toBe(false)
    expect(await trash.list()).toEqual([])
  })

  it('survives cross-instance reload (index is persisted through the backend)', async () => {
    await backend.put('survives.bin', new TextEncoder().encode('x'))
    await trash.delete('survives.bin')
    /* Fresh instance, same root + same backend. */
    const second = new Trash(root, backend)
    expect(await second.list()).toHaveLength(1)
  })
})
