/**
 * Source-level guards for the `anydoc:convert` handler.
 *
 * The handler's failure modes are mostly about what it must NOT do, and a
 * running-bundle test only observes the happy path for the pairs it exercises.
 * These assertions pin the invariants that a future edit could quietly break:
 *
 *   1. It never writes the source bytes under the destination extension. That
 *      was the original bug (a `.docx` that was really a PDF), and it is the
 *      kind of "fix" a later refactor reaches for when a converter is missing.
 *   2. The destination always goes through the managed-path guard, so a
 *      host-supplied `outPath` cannot escape FILES_DIR.
 *   3. The write is atomic, so an interrupted export never replaces a good
 *      file with a partial one.
 *   4. docx -> pdf stays refused rather than silently succeeding.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = readFileSync(join(__dirname, '..', 'src', 'anydoc', 'index.ts'), 'utf8')

/** Text of one `registerHandle('<channel>', …)` call, parens balanced. */
function handlerBody(source: string, channel: string): string {
  const marker = `registerHandle('${channel}'`
  const start = source.indexOf(marker)
  expect(start, `handler ${channel} not found`).toBeGreaterThanOrEqual(0)
  // Balance from the call's own opening paren (the one right after
  // `registerHandle`) so nested parens inside the handler — destructuring
  // defaults, helper calls — cannot end the slice early.
  const open = source.indexOf('(', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) return source.slice(open, i + 1)
    }
  }
  throw new Error('unbalanced handler body')
}

describe('anydoc:convert handler invariants', () => {
  const body = handlerBody(SOURCE, 'anydoc:convert')

  it('delegates to the real local converter', () => {
    expect(body).toContain('convertPdfToDocxBytes')
  })

  it('routes the destination through the managed-path guard', () => {
    expect(body).toMatch(/requireManagedPath\(\s*'anydoc:convert'\s*,\s*requested\s*\)/)
  })

  it('writes atomically', () => {
    expect(body).toContain('atomicWriteFile(')
    // A bare writeFileSync would leave a half-written DOCX behind on a crash.
    expect(body).not.toMatch(/\bwriteFileSync\(\s*destination/)
  })

  it('does not copy the source bytes to the destination extension', () => {
    // The old shape was `copyFileSync(path, destination)` / `writeFileSync(dest,
    // sourceBytes)`. Either would produce a file whose extension lies.
    expect(body).not.toContain('copyFileSync')
    expect(body).not.toMatch(/writeFileSync\(\s*(destination|target)\s*,/)
  })

  it('only writes after a successful conversion', () => {
    // The write must sit behind the ok/docx check, so a failed conversion
    // cannot produce a file.
    const writeAt = body.indexOf('atomicWriteFile(')
    const guardAt = body.indexOf('if (!outcome.ok || !outcome.docx)')
    expect(guardAt).toBeGreaterThanOrEqual(0)
    expect(writeAt).toBeGreaterThan(guardAt)
  })

  it('maps an encrypted PDF to a password prompt rather than a generic failure', () => {
    expect(body).toContain('PDF_PASSWORD_REQUIRED')
    expect(body).toContain('passwordRequired')
  })

  it('refuses docx -> pdf instead of pretending to convert', () => {
    expect(body).toContain('WEB_UNSUPPORTED')
    expect(body).toMatch(/sourceExt !== 'pdf' \|\| target !== 'docx'/)
  })

  it('refuses a 0-byte source instead of handing pdfium nothing', () => {
    expect(body).toMatch(/byteLength === 0/)
  })
})
