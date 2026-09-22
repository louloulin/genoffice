/**
 * Locate a python3 interpreter that can import a given module.
 *
 * These fixtures shell out to python (reportlab for PDFs, openpyxl for
 * xlsx) because generating a genuinely valid fixture in JS would mean
 * reimplementing the format. The path used to be hardcoded to the Codex
 * runtime's bundled interpreter, which does not exist on every machine —
 * the suites then failed with `spawn … ENOENT` and looked like product
 * bugs. `CODEX_PYTHON` overrides; otherwise we probe well-known locations.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const CANDIDATES = [
  process.env.CODEX_PYTHON,
  '/opt/homebrew/bin/python3',
  '/usr/local/bin/python3',
  '/usr/bin/python3',
  '/Users/louloulin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3',
].filter((p): p is string => typeof p === 'string' && p.length > 0)

const cache = new Map<string, string | null>()

/**
 * The first interpreter that can `import <module>`, or null when none can.
 * Callers should skip their suite on null rather than fail: a missing
 * fixture generator is an environment gap, not a regression.
 */
export function findPython(module: string): string | null {
  if (cache.has(module)) return cache.get(module) ?? null
  let found: string | null = null
  for (const candidate of CANDIDATES) {
    if (!existsSync(candidate)) continue
    try {
      execFileSync(candidate, ['-c', `import ${module}`], { stdio: 'ignore', timeout: 20_000 })
      found = candidate
      break
    } catch {
      /* try the next interpreter */
    }
  }
  cache.set(module, found)
  return found
}
