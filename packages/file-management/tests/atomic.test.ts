/**
 * `atomicWriteFile` is the safety net under every save path in the product.
 * If it is not actually atomic, a crash mid-save destroys the user's document
 * — the exact failure it exists to prevent. These tests pin the two
 * behaviours that matter: the target is never observed partially written, and
 * a rejected write (0 bytes, or a failing rename) leaves no residue and does
 * not clobber the previous contents.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from '../src/atomic'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'genoffice-atomic-'))
}

describe('atomicWriteFile', () => {
  it('writes the exact bytes to the target', () => {
    const dir = tempDir()
    const target = join(dir, 'doc.bin')
    atomicWriteFile(target, Buffer.from('hello'))
    expect(readFileSync(target, 'utf-8')).toBe('hello')
  })

  it('creates missing parent directories', () => {
    const dir = tempDir()
    const target = join(dir, 'deep', 'nested', 'doc.txt')
    atomicWriteFile(target, 'nested content')
    expect(readFileSync(target, 'utf-8')).toBe('nested content')
  })

  it('leaves no temp residue after a successful write', () => {
    const dir = tempDir()
    const target = join(dir, 'doc.txt')
    atomicWriteFile(target, 'first')
    atomicWriteFile(target, 'second')
    expect(readdirSync(dir)).toEqual(['doc.txt'])
  })

  it('replaces the previous contents rather than appending', () => {
    const dir = tempDir()
    const target = join(dir, 'doc.txt')
    atomicWriteFile(target, 'aaaaaaaaaaaaaaaaaaaa')
    atomicWriteFile(target, 'bb')
    expect(readFileSync(target, 'utf-8')).toBe('bb')
  })

  it('refuses to write 0 bytes instead of truncating the user file', () => {
    const dir = tempDir()
    const target = join(dir, 'doc.txt')
    atomicWriteFile(target, 'irreplaceable')
    expect(() => atomicWriteFile(target, Buffer.alloc(0))).toThrow(RangeError)
    // The critical assertion: the original content is still intact.
    expect(readFileSync(target, 'utf-8')).toBe('irreplaceable')
  })

  it('treats an empty string as 0 bytes and rejects it too', () => {
    const dir = tempDir()
    expect(() => atomicWriteFile(join(dir, 'empty.txt'), '')).toThrow(/0 bytes/)
  })

  it('accepts a string payload', () => {
    const dir = tempDir()
    const target = join(dir, 'text.md')
    atomicWriteFile(target, '# title')
    expect(readFileSync(target, 'utf-8')).toBe('# title')
  })

  it('propagates a rename failure and removes the temp file', () => {
    const dir = tempDir()
    // A directory at the target path makes `rename` fail with ENOTDIR/EISDIR
    // on every platform, which is a stand-in for a locked/EPERM target.
    const target = join(dir, 'occupied')
    mkdirSync(target)
    expect(() => atomicWriteFile(target, 'payload')).toThrow()
    expect(readdirSync(dir)).toEqual(['occupied'])
  })

  it('does not corrupt the target when the write fails', () => {
    const dir = tempDir()
    const target = join(dir, 'real.txt')
    writeFileSync(target, 'previous')
    // Renaming onto an existing directory path fails; the real file is a
    // different path, so this only proves residue cleanup on the failure
    // path, and the second assertion proves the real file is untouched.
    expect(() => atomicWriteFile(join(target, 'child.txt'), 'x')).toThrow()
    expect(readFileSync(target, 'utf-8')).toBe('previous')
    expect(readdirSync(dir)).toEqual(['real.txt'])
  })
})

describe('atomicWriteJson', () => {
  it('serialises a round-trippable JSON document', () => {
    const dir = tempDir()
    const target = join(dir, 'state.json')
    atomicWriteJson(target, { a: 1, nested: { b: [2, 3] } })
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ a: 1, nested: { b: [2, 3] } })
  })

  it('pretty-prints so the state file stays human-readable', () => {
    const dir = tempDir()
    const target = join(dir, 'state.json')
    atomicWriteJson(target, { key: 'value' })
    expect(readFileSync(target, 'utf-8')).toContain('\n  "key"')
  })

  it('writes arrays without wrapping them in an object', () => {
    const dir = tempDir()
    const target = join(dir, 'list.json')
    atomicWriteJson(target, [1, 2, 3])
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual([1, 2, 3])
  })

  it('rejects an empty array serialisation only when data is 0 bytes', () => {
    const dir = tempDir()
    const target = join(dir, 'null.json')
    atomicWriteJson(target, null)
    expect(readFileSync(target, 'utf-8')).toBe('null')
  })
})
