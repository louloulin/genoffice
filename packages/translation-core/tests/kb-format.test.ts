import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FormatError,
  KbArchive,
  TmArchive,
  makeKbManifest,
  makeTmManifest,
  readKbArchive,
  readTmArchive,
  validateKbManifest,
  validateTmManifest,
  writeKbArchive,
  writeTmArchive,
} from '../src/kb-format'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kb-format-'))
})
afterEach(() => {
  // tmpfs auto-cleanup; nothing to do
})

describe('makeKbManifest / validateKbManifest', () => {
  it('round-trips defaults', () => {
    const m = makeKbManifest({ id: 'demo', lang: 'en' })
    expect(m.v).toBe('genoffice.kb.1')
    expect(m.version).toBe('1.0.0')
    expect(m.lang).toBe('en')
    expect(m.embeddingModel).toBe('')
    expect(m.embeddingDim).toBe(0)
    expect(typeof m.createdAt).toBe('string')
    expect(() => validateKbManifest(m)).not.toThrow()
  })

  it('rejects an unknown version', () => {
    expect(() => validateKbManifest({ v: 'genoffice.kb.2', id: 'x', version: '1', lang: 'en', embeddingModel: '', embeddingDim: 0, createdAt: '' } as never)).toThrow(/unsupported manifest version/)
  })

  it('rejects missing id', () => {
    expect(() => validateKbManifest({ v: 'genoffice.kb.1', id: '', version: '1', lang: 'en', embeddingModel: '', embeddingDim: 0, createdAt: '' })).toThrow(/id required/)
  })
})

describe('readKbArchive / writeKbArchive', () => {
  it('round-trips an archive', () => {
    const archive: KbArchive = {
      manifest: makeKbManifest({ id: 'round', lang: 'zh-CN', tags: ['test'] }),
      entries: [
        { q: '苹果', a: 'apple', tags: ['fruit'] },
        { q: '香蕉', a: 'banana' },
      ],
    }
    writeKbArchive(dir, archive)
    const back = readKbArchive(dir)
    expect(back.manifest).toEqual(archive.manifest)
    expect(back.entries).toEqual(archive.entries)
  })

  it('throws when manifest.json is missing', () => {
    expect(() => readKbArchive(dir)).toThrow(/manifest.json not found/)
  })

  it('throws on a malformed entries.jsonl line', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(makeKbManifest({ id: 'x', lang: 'en' })))
    writeFileSync(join(dir, 'entries.jsonl'), '{"q":"a"}\n{not valid json}\n')
    expect(() => readKbArchive(dir)).toThrow(/entries.jsonl/)
  })
})

describe('TM format', () => {
  it('round-trips', () => {
    const archive: TmArchive = {
      manifest: makeTmManifest({ id: 'tm-demo', srcLang: 'en', tgtLang: 'zh-CN' }),
      pairs: [
        { src: 'Hello', tgt: '你好', confidence: 0.99 },
        { src: 'Goodbye', tgt: '再见', domain: 'general' },
      ],
    }
    writeTmArchive(dir, archive)
    const back = readTmArchive(dir)
    expect(back.manifest).toEqual(archive.manifest)
    expect(back.pairs).toEqual(archive.pairs)
  })

  it('rejects missing srcLang/tgtLang', () => {
    expect(() => validateTmManifest({ v: 'genoffice.tm.1', id: 'x', version: '1', srcLang: '', tgtLang: '', createdAt: '' })).toThrow(/srcLang/)
  })
})

describe('FormatError', () => {
  it('has the expected name', () => {
    expect(new FormatError('x').name).toBe('FormatError')
    expect(new FormatError('x')).toBeInstanceOf(Error)
  })
})
