import { describe, expect, it } from 'vitest'
import { sanitizeFileName, WINDOWS_RESERVED } from '../src/common/paths'

describe('sanitizeFileName', () => {
  describe('happy path', () => {
    it('keeps a plain basename', () => {
      expect(sanitizeFileName('report.docx')).toBe('report.docx')
    })
    it('preserves the original extension case but lower-cases it', () => {
      expect(sanitizeFileName('Photo.JPG')).toBe('Photo.jpg')
    })
    it('accepts nested paths and returns the leaf only', () => {
      expect(sanitizeFileName('a/b/c/file.pdf')).toBe('file.pdf')
      expect(sanitizeFileName('a\\b\\c\\file.pdf')).toBe('file.pdf')
    })
    it('falls back when the leaf is `.` or `..`', () => {
      expect(sanitizeFileName('.')).toBe('file')
      expect(sanitizeFileName('..')).toBe('file')
      expect(sanitizeFileName('a/b/.')).toBe('file')
      expect(sanitizeFileName('a/b/..')).toBe('file')
    })
    it('honours a custom fallback', () => {
      expect(sanitizeFileName('', 'upload')).toBe('upload')
      expect(sanitizeFileName(null, 'upload')).toBe('upload')
      expect(sanitizeFileName(undefined, 'upload')).toBe('upload')
    })
  })

  describe('hostile input', () => {
    it('strips POSIX path traversal', () => {
      expect(sanitizeFileName('../../../etc/passwd')).toBe('passwd')
      expect(sanitizeFileName('..\\..\\evil.exe')).toBe('evil.exe')
    })
    it('strips Windows-style separators and reserved chars', () => {
      expect(sanitizeFileName('foo:bar?.docx')).toBe('foo_bar_.docx')
      expect(sanitizeFileName('a<b>c|d*e"f.docx')).toBe('a_b_c_d_e_f.docx')
    })
    it('strips NUL and other control characters', () => {
      expect(sanitizeFileName('foo\u0000bar.docx')).toBe('foobar.docx')
      expect(sanitizeFileName('foo\u0007bar.docx')).toBe('foo_bar.docx')
      expect(sanitizeFileName('foo\u001fbar.docx')).toBe('foo_bar.docx')
    })
    it('treats Unicode look-alike separators as path separators (drops prefix)', () => {
      // \u2215 DIVISION SLASH, \uFF0F FULLWIDTH SOLIDUS, \uFF3C FULLWIDTH REVERSE SOLIDUS
      // are used by attackers as visual look-alikes for / and \. We split on
      // them so 'foo\u2215bar.docx' becomes 'bar.docx' (leaf only), matching
      // how POSIX basename behaves on the ASCII separators.
      expect(sanitizeFileName('foo\u2215bar.docx')).toBe('bar.docx')
      expect(sanitizeFileName('foo\uFF0Fbar.docx')).toBe('bar.docx')
      expect(sanitizeFileName('foo\uFF3Cbar.docx')).toBe('bar.docx')
    })
    it('strips trailing dots and spaces', () => {
      expect(sanitizeFileName('foo.docx...')).toBe('foo.docx')
      expect(sanitizeFileName('foo.docx   ')).toBe('foo.docx')
      expect(sanitizeFileName('foo   .docx.')).toBe('foo.docx')
    })
    it('refuses empty and non-string input', () => {
      expect(sanitizeFileName('')).toBe('file')
      expect(sanitizeFileName(null)).toBe('file')
      expect(sanitizeFileName(undefined)).toBe('file')
      expect(sanitizeFileName(42)).toBe('file')
      expect(sanitizeFileName({})).toBe('file')
    })
    it('refuses Windows device names even with an extension', () => {
      for (const reserved of WINDOWS_RESERVED) {
        expect(sanitizeFileName(`${reserved}.docx`)).toBe('file')
        expect(sanitizeFileName(reserved)).toBe('file')
      }
      expect(sanitizeFileName('CON')).toBe('file')
      expect(sanitizeFileName('con.docx')).toBe('file')
      expect(sanitizeFileName('Com1.docx')).toBe('file')
    })
  })

  describe('stem preservation', () => {
    it('keeps spaces and hyphens in the stem', () => {
      expect(sanitizeFileName('Annual Report 2026.docx')).toBe('Annual Report 2026.docx')
      expect(sanitizeFileName('my-file.pdf')).toBe('my-file.pdf')
    })
    it('keeps Unicode letters', () => {
      expect(sanitizeFileName('中文报告.docx')).toBe('中文报告.docx')
    })
  })
})
