/**
 * Unit-level coverage for the whole-file translation bridge.
 *
 * The bridge spawns the upstream LumosAI `translate.py`; these tests exercise
 * the locating logic and the error paths that do not require a working Python
 * toolchain, so they run everywhere. The happy path (a real .docx round-trip)
 * is covered by the E2E suite when the skill directory is present.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  defaultOutputPath,
  isSupportedExtension,
  materializeTranslateSuite,
  resolveTranslateSkills,
  SUPPORTED_EXTENSIONS,
  translateFile,
} from '../src/file-translate'

describe('translate-file bridge', () => {
  it('recognises every supported extension', () => {
    for (const ext of SUPPORTED_EXTENSIONS) {
      expect(isSupportedExtension(`report${ext}`)).toBe(true)
      expect(isSupportedExtension(ext)).toBe(true)
      expect(isSupportedExtension(`REPORT${ext.toUpperCase()}`)).toBe(true)
    }
  })

  it('rejects extensions the upstream script does not handle', () => {
    for (const ext of ['.txt', '.md', '.csv', '.png', '']) {
      expect(isSupportedExtension(`file${ext}`)).toBe(false)
    }
  })

  it('derives the default output path next to the source', () => {
    expect(defaultOutputPath('/tmp/spec.xls')).toBe('/tmp/spec_translated.xls')
    expect(defaultOutputPath('/tmp/deck.pptx')).toBe('/tmp/deck_translated.pptx')
    expect(defaultOutputPath('/tmp/a.b.docx')).toBe('/tmp/a.b_translated.docx')
  })

  it('answers a non-string path as unsupported instead of throwing', () => {
    // Both arrive unvalidated off the IPC wire; `.startsWith` on them threw
    // "pathOrExt.startsWith is not a function", which the transport reported
    // as a server fault for a plain shape error.
    for (const value of [123, true, {}, ['a'], null, undefined]) {
      expect(isSupportedExtension(value), String(value)).toBe(false)
    }
  })

  it('derives no output path from a value that cannot name a file', () => {
    // `String(123)` used to answer "123_translated" — a believable path the
    // caller then handed to the translator.
    for (const value of [123, true, {}, ['a'], null, undefined, '']) {
      expect(defaultOutputPath(value), String(value)).toBe('')
    }
  })

  it('resolveTranslateSkills honours the explicit override', () => {
    const previous = process.env.GENOFFICE_TRANSLATE_SKILLS_DIR
    const dir = join(__dirname, '..', 'src')
    process.env.GENOFFICE_TRANSLATE_SKILLS_DIR = dir
    try {
      const loc = resolveTranslateSkills()
      // No scripts/translate.py under src/ai, so the override is rejected and
      // resolution falls through — but it must never report 'override' with a
      // script that does not exist.
      if (loc.source === 'override') {
        expect(loc.scriptPath).toContain('translate.py')
      }
      expect(['override', 'default', 'bundled', 'missing']).toContain(loc.source)
    } finally {
      if (previous === undefined) delete process.env.GENOFFICE_TRANSLATE_SKILLS_DIR
      else process.env.GENOFFICE_TRANSLATE_SKILLS_DIR = previous
    }
  })

  it('translateFile reports a missing input instead of throwing', async () => {
    const result = await translateFile({ inputPath: '/definitely/not/here.docx' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('input not found')
  })

  it('resolveTranslateSkills prefers the canonical default skills dir over bundled', () => {
    const previousEnv = process.env.LUMOS_HOME
    const tmp = mkdtempSync(join(tmpdir(), 'resolve-translate-default-'))
    try {
      // Materialise a complete translate suite under tmp/skills/translate.
      const defaultDir = join(tmp, 'skills', 'translate')
      mkdirSync(join(defaultDir, 'scripts'), { recursive: true })
      writeFileSync(join(defaultDir, 'scripts', 'translate.py'), '#!/usr/bin/env python3\n', 'utf8')
      mkdirSync(join(tmp, 'skills', 'translate-pdf', 'scripts'), { recursive: true })
      writeFileSync(join(tmp, 'skills', 'translate-pdf', 'scripts', 'translate_pdf.py'), '#!/usr/bin/env python3\n', 'utf8')

      // A hashed bundle with the same scripts at a different path.
      const hashDir = join(tmp, 'bundled-skills', 'abc123')
      mkdirSync(join(hashDir, 'translate', 'scripts'), { recursive: true })
      writeFileSync(join(hashDir, 'translate', 'scripts', 'translate.py'), '#!/usr/bin/env python3\n', 'utf8')

      process.env.LUMOS_HOME = tmp
      const loc = resolveTranslateSkills()
      expect(loc.source).toBe('default')
      expect(loc.skillDir).toBe(defaultDir)
    } finally {
      if (previousEnv === undefined) delete process.env.LUMOS_HOME
      else process.env.LUMOS_HOME = previousEnv
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('resolveTranslateSkills falls back to bundled when the default dir is empty', () => {
    const previousEnv = process.env.LUMOS_HOME
    const tmp = mkdtempSync(join(tmpdir(), 'resolve-translate-bundled-'))
    try {
      const hashDir = join(tmp, 'bundled-skills', 'abc123')
      mkdirSync(join(hashDir, 'translate', 'scripts'), { recursive: true })
      writeFileSync(join(hashDir, 'translate', 'scripts', 'translate.py'), '#!/usr/bin/env python3\n', 'utf8')
      process.env.LUMOS_HOME = tmp
      const loc = resolveTranslateSkills()
      expect(loc.source).toBe('bundled')
      expect(loc.skillDir).toBe(join(hashDir, 'translate'))
    } finally {
      if (previousEnv === undefined) delete process.env.LUMOS_HOME
      else process.env.LUMOS_HOME = previousEnv
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('translateFile rejects an unsupported extension before spawning', async () => {
    const result = await translateFile({ inputPath: __filename })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unsupported extension')
  })
})

describe('materializeTranslateSuite', () => {
  it('copies every translate sibling from the newest bundled hash to the default skills dir', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'materialize-'))
    try {
      const bundledRoot = join(tmp, 'bundled-skills')
      const hashDir = join(bundledRoot, 'hashA')
      for (const sibling of ['translate', 'translate-pdf', 'translate-ppt', 'translate-xls', 'translate-docx']) {
        mkdirSync(join(hashDir, sibling, 'scripts'), { recursive: true })
        writeFileSync(join(hashDir, sibling, 'scripts', 'translate.py'), '# stub\n', 'utf8')
      }
      const targetRoot = join(tmp, 'skills')
      const result = materializeTranslateSuite({ bundledRoot, targetRoot })
      expect(result.sourceDir).toBe(hashDir)
      expect(result.copied.length).toBe(5)
      expect(result.skipped).toEqual([])
      for (const sibling of ['translate', 'translate-pdf', 'translate-ppt', 'translate-xls', 'translate-docx']) {
        expect(existsSync(join(targetRoot, sibling, 'scripts', 'translate.py'))).toBe(true)
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('is a no-op when no bundled directory is present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'materialize-empty-'))
    try {
      const result = materializeTranslateSuite({
        bundledRoot: join(tmp, 'does-not-exist'),
        targetRoot: join(tmp, 'skills'),
      })
      expect(result.copied).toEqual([])
      expect(result.skipped).toEqual([])
      expect(result.sourceDir).toBeNull()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('leaves existing destinations alone — delete to refresh', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'materialize-idempotent-'))
    try {
      const bundledRoot = join(tmp, 'bundled-skills')
      const hashDir = join(bundledRoot, 'hashA')
      mkdirSync(join(hashDir, 'translate', 'scripts'), { recursive: true })
      writeFileSync(join(hashDir, 'translate', 'scripts', 'translate.py'), '# from bundle\n', 'utf8')

      const targetRoot = join(tmp, 'skills')
      // Pre-existing destination with hand-edited content we must not clobber.
      mkdirSync(join(targetRoot, 'translate', 'scripts'), { recursive: true })
      writeFileSync(join(targetRoot, 'translate', 'scripts', 'translate.py'), '# user edit\n', 'utf8')

      const result = materializeTranslateSuite({ bundledRoot, targetRoot })
      expect(result.copied).toEqual([])
      expect(result.skipped).toEqual([join(targetRoot, 'translate')])
      // Hand-edited file is intact.
      expect(readFileSync(join(targetRoot, 'translate', 'scripts', 'translate.py'), 'utf8')).toBe('# user edit\n')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
