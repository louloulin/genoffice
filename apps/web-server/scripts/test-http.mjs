/**
 * Runs the `node:test` suites under `src/<area>/__tests__/`.
 *
 * These are a *different* runner from vitest, which only collects `tests/**`
 * (see vitest.config.ts). Before this script existed nothing ran them at all.
 *
 * Why not a plain `tsx --test 'src/**\/__tests__/*.test.ts'`: when that glob
 * matches nothing, node:test prints `pass 0 / fail 0` and **exits 0**. A rename
 * of the directory would then turn this gate green while executing nothing —
 * the exact "found no baseline, called it a pass" failure the suites themselves
 * guard against. So resolve the file list first and refuse to report success on
 * an empty one.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const srcRoot = join(packageRoot, 'src')

const files = readdirSync(srcRoot, { recursive: true })
  .map(String)
  .filter((entry) => entry.endsWith('.test.ts'))
  .filter((entry) => entry.split(/[\\/]/).includes('__tests__'))
  .map((entry) => join(srcRoot, entry))
  .sort()

if (files.length === 0) {
  process.stderr.write(
    '[test-http] no node:test suites found under src/**/__tests__/ — refusing to report success\n',
  )
  process.exit(1)
}

// tsx is hoisted to the workspace root; createRequire walks up to find it.
// Spawning the CLI through process.execPath avoids depending on PATH or a
// shell, which is what makes `spawn('tsx')` silently fail on Windows.
const require = createRequire(import.meta.url)
const tsxPackagePath = require.resolve('tsx/package.json')
const tsxBin = JSON.parse(readFileSync(tsxPackagePath, 'utf8')).bin
const tsxCli = join(dirname(tsxPackagePath), typeof tsxBin === 'string' ? tsxBin : tsxBin.tsx)

process.stderr.write(`[test-http] running ${files.length} node:test suite(s)\n`)

const result = spawnSync(process.execPath, [tsxCli, '--test', ...files], {
  cwd: packageRoot,
  stdio: 'inherit',
})

if (result.error) {
  process.stderr.write(`[test-http] failed to start the test runner: ${result.error.message}\n`)
  process.exit(1)
}
process.exit(result.status ?? 1)
