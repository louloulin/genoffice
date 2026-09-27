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
const repoRoot = resolve(pkgRoot, '..', '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')

/**
 * Every source tree the bundle is built from.
 *
 * The bundle inlines the `@genoffice/*` workspace packages — they are not in
 * its `--external` list — so the server's own `src/` is not the only thing
 * that can make the artifact stale. Watching only `pkgRoot/src` let an edit to
 * `packages/translation-core/src` leave the *previous* bundle in place, and the
 * e2e suites then asserted against code nobody had just written: the fix
 * looked like it did nothing, which is the second failure mode above, arriving
 * through a door this file had left open.
 *
 * `packages/<name>/src` deliberately, not `packages/<name>`: the latter
 * includes each package's own build output, which a build rewrites, and the
 * guard would then rebuild on every single run.
 */
function sourceDirs(): string[] {
  const dirs = [join(pkgRoot, 'src')]
  const packagesDir = join(repoRoot, 'packages')
  let names: string[]
  try {
    names = readdirSync(packagesDir)
  } catch {
    return dirs
  }
  for (const name of names) {
    const dir = join(packagesDir, name, 'src')
    if (existsSync(dir)) dirs.push(dir)
  }
  return dirs
}

/** Newest mtime across a directory tree, or 0 when it does not exist. */
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

function newestSourceMtime(): number {
  let newest = 0
  for (const dir of sourceDirs()) newest = Math.max(newest, newestMtime(dir))
  return newest
}

export default function setup(): void {
  const needsBuild = !existsSync(bundle) || statSync(bundle).mtimeMs < newestSourceMtime()
  if (!needsBuild) return
  // stderr, so the rebuild note never corrupts a suite's stdout assertions.
  process.stderr.write(
    existsSync(bundle)
      ? '[web-server tests] sources are newer than the bundle — rebuilding before the e2e suites run\n'
      : '[web-server tests] no bundle found — building it before the e2e suites run\n',
  )
  execFileSync('node', [join(pkgRoot, 'scripts', 'bundle.mjs')], {
    cwd: pkgRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
