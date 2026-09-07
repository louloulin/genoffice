#!/usr/bin/env node
// Repository-wide English-only guard: no Chinese may appear in tracked code
// comments or documentation prose. Catch violations in the change that
// introduces them.
//
// Functional CJK string literals are fine (i18n resources, test fixture
// text, zh-UI matchers), as are the AI prompt guides (runtime resources that
// legitimately show CJK examples) and the docs/comet change journal (internal
// per-change working notes, not contributor-facing documentation).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const HAN = /[\u3400-\u9fff]/

const git = spawnSync('git', ['ls-files'], { encoding: 'utf8' })
if (git.status !== 0) {
  console.error(git.stderr)
  process.exit(git.status ?? 1)
}
const root = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()

const violations = []
for (const file of git.stdout.trim().split('\n')) {
  const isCode = /\.(ts|tsx|mjs|cjs|js)$/.test(file)
  const isDoc =
    /\.(md|html?)$/.test(file) && !file.includes('/ai/prompts/') && !file.startsWith('docs/comet/')
  if (!isCode && !isDoc) continue
  const absolute = join(root, file)
  // A tracked file can be missing from the working tree mid-change (staged
  // rename or delete); nothing to inspect and not a violation.
  if (!existsSync(absolute)) continue
  const lines = readFileSync(absolute, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const text = isDoc
      ? line
      : (line.match(/(?:^|[^:'"])\/\/(.*)$/) ??
          line.match(/^\s*\*(.*)$/) ??
          line.match(/\/\*(.*)$/))?.[1]
    if (text !== undefined && HAN.test(text)) {
      violations.push(`  ${file}:${index + 1}: ${line.trim()}`)
    }
  })
}

if (violations.length > 0) {
  console.error(
    `Chinese text found in code comments or docs:\n${violations.join('\n')}\n` +
      'Comments and documentation must be English-only. Move CJK text into ' +
      'string literals or rewrite the comment in English.',
  )
  process.exit(1)
}
console.log('check-english-comments: OK')
