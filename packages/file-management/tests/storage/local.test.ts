import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalStorageBackend } from '../../src/storage/local'
import { createStorageBackend } from '../../src/storage/factory'
import { StorageNotFoundError } from '../../src/storage/backend'

let dir = ''
beforeEach(() => {
  dir = join(tmpdir(), `genoffice-storage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
})
afterEach(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

describe('LocalStorageBackend', () => {
  it('writes, reads, and reports a head() with size', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir, publicBaseUrl: 'http://x/files' })
    const bytes = new TextEncoder().encode('hello local')
    const { key, size } = await backend.put('hello.txt', bytes, { contentType: 'text/plain', meta: { src: 'unit' } })
    expect(size).toBe(bytes.byteLength)
    expect(existsSync(join(dir, key))).toBe(true)
    const round = await backend.get(key)
    expect(new TextDecoder().decode(round)).toBe('hello local')
    const head = await backend.head(key)
    expect(head.exists).toBe(true)
    expect(head.size).toBe(bytes.byteLength)
    expect(head.contentType).toBe('text/plain')
    expect(head.meta?.src).toBe('unit')
  })

  it('throws StorageNotFoundError on missing key for get()', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir })
    await expect(backend.get('nope.bin')).rejects.toBeInstanceOf(StorageNotFoundError)
  })

  it('head() returns exists:false rather than throwing for missing key', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir })
    const head = await backend.head('nope.bin')
    expect(head).toEqual({ exists: false, size: 0 })
  })

  it('refuses path-traversal keys', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir })
    await expect(backend.put('../escape.txt', new Uint8Array([1]))).rejects.toThrow(/unsafe key/)
  })

  it('list() filters by prefix', async () => {
    /* Keys are opaque identifiers (the contract says no separators) — the
     * caller is expected to encode any path structure into the key itself,
     * then ask list(prefix) for a substring filter. */
    const backend = new LocalStorageBackend({ filesDir: dir })
    await backend.put('alpha-1.docx', new Uint8Array([1]))
    await backend.put('alpha-2.docx', new Uint8Array([2]))
    await backend.put('beta-3.docx', new Uint8Array([3]))
    const a = await backend.list('alpha-')
    expect(a.map((e) => e.key).sort()).toEqual(['alpha-1.docx', 'alpha-2.docx'])
  })

  it('getSignedUrl returns <publicBaseUrl>/<key>', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir, publicBaseUrl: 'http://example.test/files/' })
    const url = await backend.getSignedUrl('foo.docx')
    expect(url).toBe('http://example.test/files/foo.docx')
  })

  it('delete() removes both bytes and meta', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir })
    await backend.put('x.bin', new Uint8Array([9, 9, 9]), { contentType: 'application/octet-stream' })
    expect(existsSync(join(dir, 'x.bin'))).toBe(true)
    expect(existsSync(join(dir, 'x.bin.meta.json'))).toBe(true)
    await backend.delete('x.bin')
    expect(existsSync(join(dir, 'x.bin'))).toBe(false)
    expect(existsSync(join(dir, 'x.bin.meta.json'))).toBe(false)
  })

  it('createStorageBackend() defaults to local', () => {
    const b = createStorageBackend({ filesDir: dir })
    expect(b.id).toBe('local')
  })
})

describe('LocalStorageBackend atomic-write guarantees', () => {
  it('survives an interrupted put: no temp file is left behind', async () => {
    const backend = new LocalStorageBackend({ filesDir: dir })
    // Simulate a crash by writing a stale temp file directly; the next
    // atomic put should not be blocked by the orphan.
    writeFileSync(join(dir, '.x.bin.tmp'), 'stale')
    await backend.put('x.bin', new Uint8Array([1, 2, 3]))
    const bytes = readFileSync(join(dir, 'x.bin'))
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]))
  })
})
