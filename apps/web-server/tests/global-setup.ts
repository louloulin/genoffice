/**
 * Vitest global setup for the web-server package.
 *
 * Every e2e suite here spawns `dist/bundle/index.js` and drives it over HTTP.
 * That bundle is gitignored, which creates two failure modes this file exists
 * to remove:
 *
 *   1. A clean checkout has no bundle at all, so the suites fail on spawn with
 *      ENOENT instead of testing anything.
 *   2. A developer's working tree keeps an *old* bundle. The tests then pass or
 *      fail against code that is not the code being edited — a fix in `src/`
 *      looks like it did nothing, and a regression can hide behind a stale
 *      artifact for as long as nobody rebuilds by hand.
 *
 * Rebuilding here makes the bundle a derived artifact of the test run rather
 * than something a human has to remember. It is deliberately not an npm
 * `pretest` hook: this repo sets `ignore-scripts=true`, which silently disables
 * lifecycle scripts, and a guarantee that disappears under a common npm setting
 * is not a guarantee.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const srcDir = join(pkgRoot, 'src')

/** Newest mtime under a directory tree, or 0 when it does not exist. */
function newestMtime(dir: string): number {
  let newest = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()!
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(current, entry)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(full)
      else if (st.mtimeMs > newest) newest = st.mtimeMs
    }
  }
  return newest
}

export default function setup(): void {
  const needsBuild =
    !existsSync(bundle) || statSync(bundle).mtimeMs < newestMtime(srcDir)
  if (!needsBuild) return
  // stderr, so the rebuild note never corrupts a suite's stdout assertions.
  process.stderr.write(
    existsSync(bundle)
      ? '[web-server tests] src/ is newer than the bundle — rebuilding before the e2e suites run\n'
      : '[web-server tests] no bundle found — building it before the e2e suites run\n',
  )
  execFileSync('node', [join(pkgRoot, 'scripts', 'bundle.mjs')], {
    cwd: pkgRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
