import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  atomicWriteJson,
  DAILY_PASTE_LIMIT_BYTES,
  randomFileId,
  reserveDailyPasteQuota,
  sweepWebTempRoot,
} from '../src/common/atomic'

function freshTmpDir(name: string): string {
  const dir = join(tmpdir(), `genoffice-test-${name}-${randomFileId('dir').split('-')[0]}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('atomicWriteJson', () => {
  let dir: string
  beforeEach(() => {
    dir = freshTmpDir('atomic')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes JSON to the target path', () => {
    const target = join(dir, 'a.json')
    atomicWriteJson(target, { hello: 'world', count: 1 })
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ hello: 'world', count: 1 })
  })

  it('overwrites existing files', () => {
    const target = join(dir, 'a.json')
    atomicWriteJson(target, { v: 1 })
    atomicWriteJson(target, { v: 2 })
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ v: 2 })
  })

  it('creates parent directories as needed', () => {
    const target = join(dir, 'deep', 'nested', 'a.json')
    atomicWriteJson(target, { ok: true })
    expect(existsSync(target)).toBe(true)
  })

  it('does not leave temp files behind on success', () => {
    const target = join(dir, 'a.json')
    atomicWriteJson(target, { ok: 1 })
    const leftover = require('node:fs').readdirSync(dir).filter((f: string) => f.endsWith('.tmp'))
    expect(leftover).toEqual([])
  })
})

describe('randomFileId', () => {
  it('returns a UUID-suffixed basename', () => {
    const id = randomFileId('foo.docx')
    expect(id).toMatch(/^[0-9a-f-]{36}-foo\.docx$/)
  })
  it('sanitises the supplied name', () => {
    const id = randomFileId('../../etc/passwd')
    expect(id).toMatch(/^[0-9a-f-]{36}-passwd$/)
  })
  it('uses the fallback when the name is unusable', () => {
    const id = randomFileId('')
    expect(id).toMatch(/^[0-9a-f-]{36}-file$/)
  })
  it('never collides on consecutive calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i += 1) ids.add(randomFileId('x'))
    expect(ids.size).toBe(1000)
  })
})

describe('reserveDailyPasteQuota', () => {
  let dir: string
  let file: string
  beforeEach(() => {
    dir = freshTmpDir('quota')
    file = join(dir, 'paste.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the running total after a successful reservation', () => {
    const total = reserveDailyPasteQuota(file, 1024)
    expect(total).toBe(1024)
    const total2 = reserveDailyPasteQuota(file, 2048)
    expect(total2).toBe(3072)
  })

  it('persists across re-reads', () => {
    reserveDailyPasteQuota(file, 4096)
    const reread = reserveDailyPasteQuota(file, 0)
    expect(reread).toBe(4096)
  })

  it('rejects reservations that would exceed the daily cap', () => {
    // Pre-fill the counter to (cap - 1) for TODAY so the next 2-byte
    // reservation fails. The counter is keyed on UTC day, so we compute
    // today's marker from the helper's perspective.
    const fileWithCap = join(dir, 'cap.json')
    const today = new Date().toISOString().slice(0, 10)
    writeFileSync(
      fileWithCap,
      JSON.stringify({ day: today, used: DAILY_PASTE_LIMIT_BYTES - 1 }),
    )
    expect(() => reserveDailyPasteQuota(fileWithCap, 2)).toThrow(/quota exceeded/)
  })

  it('resets when the day rolls over', () => {
    const yesterday = Date.now() - 2 * 24 * 60 * 60 * 1000
    writeFileSync(
      file,
      JSON.stringify({ day: 'yesterday', used: 50_000_000, ts: yesterday }),
    )
    const total = reserveDailyPasteQuota(file, 100)
    // Counter should start fresh — total is just the new reservation.
    expect(total).toBe(100)
  })

  it('recovers from a corrupt counter file', () => {
    writeFileSync(file, '{ not json')
    const total = reserveDailyPasteQuota(file, 100)
    expect(total).toBe(100)
  })
})

describe('sweepWebTempRoot', () => {
  let dir: string
  beforeEach(() => {
    dir = freshTmpDir('sweep')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('removes upload-* directories older than maxAgeMs', () => {
    const stale = join(dir, 'upload-old-stamp')
    const fresh = join(dir, 'upload-new-stamp')
    mkdirSync(stale)
    mkdirSync(fresh)
    // Force "stale" to be older than 1 hour
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    utimesSync(stale, longAgo, longAgo)
    const result = sweepWebTempRoot(dir, 60 * 60 * 1000)
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('is a no-op when WEB_TEMP_ROOT does not exist', () => {
    const missing = join(dir, 'nope')
    const result = sweepWebTempRoot(missing)
    expect(result).toEqual({ removed: 0, kept: 0 })
  })

  it('keeps non-upload entries (other tmp files) untouched', () => {
    const other = join(dir, 'not-an-upload.tmp')
    writeFileSync(other, 'data')
    const result = sweepWebTempRoot(dir)
    expect(result.kept).toBe(1)
    expect(result.removed).toBe(0)
    expect(existsSync(other)).toBe(true)
  })
})

// Sanity: writeFileSync exists check ensures the import shape stays correct
it('uses node:fs APIs the same way the production code does', () => {
  const probe = join(tmpdir(), 'genoffice-atomic-probe')
  writeFileSync(probe, Buffer.from('probe'))
  expect(statSync(probe).size).toBe(5)
  rmSync(probe)
})
