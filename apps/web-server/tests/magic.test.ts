import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { assertMagicMatchesExtension, detectFileMagic, MagicMismatchError } from '../src/common/magic'

function zipBytes(payload: Buffer = Buffer.from('hello world')): Buffer {
  const local = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from([0x14, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, payload.length, 0, payload.length, 0]),
    payload,
  ])
  return local
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('IHDR'),
  ])
}

function jpegBytes(): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF')])
}

function gif87a(): Buffer {
  return Buffer.concat([Buffer.from('GIF87a'), Buffer.from([0x01, 0x00, 0x01, 0x00])])
}

function gif89a(): Buffer {
  return Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x01, 0x00, 0x01, 0x00])])
}

function webpBytes(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x1a, 0, 0, 0]),
    Buffer.from('WEBP'),
    Buffer.from('VP8 '),
  ])
}

function pdfBytes(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('binary stuff')])
}

function plainBytes(text: string): Buffer {
  return Buffer.from(text, 'utf8')
}

describe('detectFileMagic', () => {
  it('detects zip', () => {
    expect(detectFileMagic(zipBytes())).toBe('zip')
  })
  it('detects pdf', () => {
    expect(detectFileMagic(pdfBytes())).toBe('pdf')
  })
  it('detects png', () => {
    expect(detectFileMagic(pngBytes())).toBe('png')
  })
  it('detects jpeg', () => {
    expect(detectFileMagic(jpegBytes())).toBe('jpeg')
  })
  it('detects gif87a and gif89a', () => {
    expect(detectFileMagic(gif87a())).toBe('gif')
    expect(detectFileMagic(gif89a())).toBe('gif')
  })
  it('detects webp via RIFF + WEBP marker at offset 8', () => {
    expect(detectFileMagic(webpBytes())).toBe('webp')
    // wrong tag at offset 8 should not be webp
    const bogus = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x10, 0, 0, 0]),
      Buffer.from('WAVE'),
    ])
    expect(detectFileMagic(bogus)).not.toBe('webp')
  })
  it('detects plain text', () => {
    expect(detectFileMagic(plainBytes('Hello, world!\n'))).toBe('plain')
    expect(detectFileMagic(plainBytes('# Markdown document\n\n- item one'))).toBe('plain')
    expect(detectFileMagic(plainBytes('{"json": true, "ok": 1}'))).toBe('plain')
  })
  it('returns null on empty buffer', () => {
    expect(detectFileMagic(Buffer.alloc(0))).toBeNull()
  })
  it('returns null on NUL-heavy binary masquerading as text', () => {
    // High NUL density disqualifies as plain text.
    const buf = Buffer.alloc(64, 0)
    expect(detectFileMagic(buf)).toBeNull()
  })
})

describe('assertMagicMatchesExtension', () => {
  it('passes when docx bytes are real zip', () => {
    expect(() =>
      assertMagicMatchesExtension('docs:open-path', '/tmp/foo.docx', zipBytes()),
    ).not.toThrow()
  })
  it('throws MagicMismatchError when .docx bytes are actually JPEG', () => {
    expect(() =>
      assertMagicMatchesExtension('docs:open-path', '/tmp/foo.docx', jpegBytes()),
    ).toThrowError(MagicMismatchError)
  })
  it('throws MagicMismatchError when .pdf bytes are actually plain text', () => {
    expect(() =>
      assertMagicMatchesExtension('anydoc:recognize', '/tmp/foo.pdf', plainBytes('not a pdf')),
    ).toThrowError(MagicMismatchError)
  })
  it('accepts an ArrayBuffer (not just Buffer)', () => {
    const buf = zipBytes()
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    expect(() => assertMagicMatchesExtension('docs:open-path', '/tmp/foo.docx', ab)).not.toThrow()
  })
  it('passes through unknown extensions (`.foo`)', () => {
    expect(() =>
      assertMagicMatchesExtension('docs:open-path', '/tmp/foo.bar', plainBytes('whatever')),
    ).not.toThrow()
  })
  it('passes when .txt bytes are plain text', () => {
    expect(() =>
      assertMagicMatchesExtension('anydoc:extract-text', '/tmp/notes.txt', plainBytes('todo list')),
    ).not.toThrow()
  })
  it('reports the channel and detected magic on rejection', () => {
    try {
      assertMagicMatchesExtension('docs:open-path', '/tmp/foo.pdf', pngBytes())
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(MagicMismatchError)
      const e = error as MagicMismatchError
      expect(e.channel).toBe('docs:open-path')
      expect(e.declaredExtension).toBe('.pdf')
      expect(e.actualMagic).toBe('png')
    }
  })
})
