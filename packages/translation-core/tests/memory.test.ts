import { describe, expect, it } from 'vitest'

import { TranslationMemory } from '../src/memory'

describe('TranslationMemory', () => {
  it('round-trips save / lookup by source text', () => {
    const mem = new TranslationMemory()
    mem.save({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceText: 'Hello',
      translatedText: '你好',
    })
    const hit = mem.lookup('en-US', 'zh-CN', 'Hello')
    expect(hit?.translatedText).toBe('你好')
  })

  it('treats whitespace-only variants of the source as the same key', () => {
    const mem = new TranslationMemory()
    mem.save({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceText: 'Hello world',
      translatedText: '你好世界',
    })
    expect(mem.lookup('en-US', 'zh-CN', '  Hello   world  ')?.translatedText).toBe('你好世界')
  })

  it('returns null for missing entries', () => {
    const mem = new TranslationMemory()
    expect(mem.lookup('en-US', 'zh-CN', 'anything')).toBeNull()
  })

  it('ignores a non-string bucket on save/lookup rather than crashing', () => {
    // `bucket` arrives straight from the wire. A number or boolean used to
    // crash `bucket.trim is not a function`; the type guard treats anything
    // that isn't a non-empty string as "no bucket", so a save lands in the
    // unscoped namespace and lookups that pass a non-string also match it.
    const mem = new TranslationMemory()
    mem.save({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceText: 'Hello',
      translatedText: '你好',
      bucket: 7 as unknown as string,
    })
    expect(mem.lookup('en-US', 'zh-CN', 'Hello')?.translatedText).toBe('你好')
    expect(mem.lookup('en-US', 'zh-CN', 'Hello', true as unknown as string)?.translatedText).toBe('你好')
    expect(mem.lookup('en-US', 'zh-CN', 'Hello', {} as unknown as string)?.translatedText).toBe('你好')
  })

  it('saveMany counts saved vs skipped units', () => {
    const mem = new TranslationMemory()
    const r = mem.saveMany({
      scene: 'doc',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      units: [
        { unitId: 'a', sourceText: 'Hello', translatedText: '你好' },
        { unitId: 'b', sourceText: 'World', translatedText: '' },
        { unitId: 'c', sourceText: '   ', translatedText: ' ' },
      ],
    })
    expect(r.ok).toBe(true)
    expect(r.savedCount).toBe(1)
    expect(r.skippedCount).toBe(2)
  })

  it('rejects a non-array `units` instead of throwing on it', () => {
    // `saveMany` is reachable straight from IPC, so `units` is whatever the
    // caller typed. Iterating a string spread its characters and iterating
    // `null` threw out of the handler, which the transport reported as HTTP
    // 500 — a malformed save presented as a server fault.
    const mem = new TranslationMemory()
    for (const units of ['nope', {}, null, undefined, 3] as unknown[]) {
      const r = mem.saveMany({
        scene: 'doc',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        units: units as never,
      })
      expect(r.ok).toBe(false)
      expect(r.error).toBe('units must be an array')
      expect(r.savedCount).toBe(0)
    }
    expect(mem.size()).toBe(0)
  })

  it('skips malformed unit elements rather than dereferencing them', () => {
    const mem = new TranslationMemory()
    const r = mem.saveMany({
      scene: 'doc',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      units: [
        null,
        { unitId: 'missing-target', sourceText: 'Hello' },
        { unitId: 'numeric', sourceText: 'World', translatedText: 42 },
        { unitId: 'ok', sourceText: 'Hi', translatedText: '你好' },
      ] as never,
    })
    expect(r.ok).toBe(true)
    expect(r.savedCount).toBe(1)
    expect(r.skippedCount).toBe(3)
    expect(mem.lookup('en-US', 'zh-CN', 'Hi')?.translatedText).toBe('你好')
  })

  it('keeps per-customer buckets isolated so translations never leak across', () => {
    const tm = new TranslationMemory()
    tm.save({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceText: 'fabric weight',
      translatedText: '克重(KERRITS)',
      bucket: 'KERRITS',
    })
    tm.save({
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      sourceText: 'fabric weight',
      translatedText: '克重(ACME)',
      bucket: 'ACME',
    })

    expect(
      tm.lookup('en-US', 'zh-CN', 'fabric weight', 'KERRITS')?.translatedText,
    ).toBe('克重(KERRITS)')
    expect(
      tm.lookup('en-US', 'zh-CN', 'fabric weight', 'ACME')?.translatedText,
    ).toBe('克重(ACME)')
    // A different bucket must not see either customer's translation.
    expect(tm.lookup('en-US', 'zh-CN', 'fabric weight', 'OTHER')).toBeNull()
    // An unscoped lookup must not see bucketed entries either.
    expect(tm.lookup('en-US', 'zh-CN', 'fabric weight')).toBeNull()
  })

  it('saveMany stores the bucket so batch memory respects customer scopes', () => {
    const tm = new TranslationMemory()
    tm.saveMany({
      scene: 'batch',
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      bucket: 'KERRITS',
      units: [{ unitId: 'u1', sourceText: 'waistband', translatedText: '腰头(K)' }],
    })
    expect(tm.lookup('en-US', 'zh-CN', 'waistband', 'KERRITS')?.translatedText).toBe('腰头(K)')
    expect(tm.lookup('en-US', 'zh-CN', 'waistband', 'ACME')).toBeNull()
    expect(tm.lookup('en-US', 'zh-CN', 'waistband')).toBeNull()
  })

  it('evicts the oldest entries when capacity is exceeded', () => {
    const mem = new TranslationMemory({ maxEntries: 10 })
    for (let i = 0; i < 25; i++) {
      mem.save({
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        sourceText: `s-${i}`,
        translatedText: `t-${i}`,
      })
    }
    expect(mem.size()).toBeLessThanOrEqual(10)
  })
})
