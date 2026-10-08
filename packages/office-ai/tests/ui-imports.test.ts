import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The UI handler layer is node-only and must stay importable from a plain Node
 * host (aiwork, a CLI, a server). The desktop slides main-process modules wrap
 * their media helpers in `render-helpers.ts`, which pulls harfbuzz wasm AND
 * Electron — so a single `import … from 'electron'` in a handler turns the whole
 * library into a desktop-only package and fails at require time for every
 * consumer that is not Electron.
 *
 * Risk #4 in the plan. This assertion is the cheap guard for it.
 */
const UI_SRC = fileURLToPath(new URL('../src/ui', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

describe('ui handler layer import hygiene', () => {
  const files = walk(UI_SRC)

  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('never imports electron', () => {
    const offenders: string[] = []
    for (const file of files) {
      if (/(?:from\s+|require\(\s*)['"]electron['"]/.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.slice(UI_SRC.length + 1))
      }
    }
    expect(offenders).toEqual([])
  })
})