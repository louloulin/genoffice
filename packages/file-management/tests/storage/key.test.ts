/**
 * Content-addressed key derivation. The key shape is what flows into the
 * storage backend as the bucket object name — anything that goes wrong here
 * leaks garbage into MinIO/S3.
 */
import { describe, expect, it } from 'vitest'
import { keyForFile } from '../../src/storage/key'

describe('keyForFile', () => {
  it('derives a date-prefixed, content-hashed key', () => {
    const bytes = new TextEncoder().encode('hello world')
    const key = keyForFile({
      bytes,
      name: 'note.txt',
      now: () => new Date('2025-06-15T12:00:00Z'),
    })
    expect(key).toMatch(/^2025\/06\/15\/[0-9a-f]{16}\.txt$/)
  })

  it('same bytes produce the same key (content-addressed dedupe)', () => {
    const a = keyForFile({ bytes: new Uint8Array([1, 2, 3]), name: 'a.bin' })
    const b = keyForFile({ bytes: new Uint8Array([1, 2, 3]), name: 'b.bin' })
    /* Identical bytes must hash identically; the filename is ignored. */
    expect(a).toBe(b)
  })

  it('different bytes produce different keys', () => {
    const a = keyForFile({ bytes: new Uint8Array([1]), name: 'a.bin' })
    const b = keyForFile({ bytes: new TextEncoder().encode('hello'), name: 'a.bin' })
    expect(a).not.toBe(b)
  })

  it('produces bucket-friendly keys (no spaces, no unsafe characters)', () => {
    const trickyNames = [
      'Annual Report 2024.pdf',
      '中文文档.docx',
      '../../etc/passwd',
      'name with weird chars!@#$.txt',
      'slide deck v1 (final).pptx',
    ]
    for (const name of trickyNames) {
      const key = keyForFile({
        bytes: new TextEncoder().encode(name),
        name,
        now: () => new Date('2025-01-02T03:04:05Z'),
      })
      /* No whitespace, no slashes inside the basename, no unicode. */
      expect(key).toMatch(/^2025\/01\/02\/[0-9a-f]{16}\.[a-z0-9]+$/)
      expect(key).not.toMatch(/[ "]/)
      expect(key).not.toMatch(/[^\x20-\x7E/]/)
    }
  })

  it('infers a sensible extension from mime type when the name has none', () => {
    const key = keyForFile({
      bytes: new TextEncoder().encode('{}'),
      name: 'no-ext',
      mimeType: 'application/json',
    })
    expect(key.endsWith('.json')).toBe(true)
  })

  it('falls back to .bin when nothing usable can be derived', () => {
    const key = keyForFile({
      bytes: new TextEncoder().encode('???'),
      name: '',
      mimeType: 'application/x-unknown',
    })
    expect(key.endsWith('.bin')).toBe(true)
  })

  it('lowercases the extension and strips anything non-alphanumeric', () => {
    const key = keyForFile({
      bytes: new TextEncoder().encode('x'),
      name: 'REPORT.PDF!@#',
    })
    /* The .PDF!@# part must collapse to .pdf (no other junk). */
    expect(key.endsWith('.pdf')).toBe(true)
  })
})
