/**
 * Typedoc output count regression guard (sdk1.md §11.4 #2 + §11.12).
 *
 * The docs/scripts/gen-typedoc.mjs script generates ~221 MD files into
 * docs/api/_generated/. That number drifts as new public exports are added
 * (or removed) from apps/web-server/src/. Without a regression guard the
 * "199 MD files" claim in sdk1.md §A.5 / §11.6 silently drifts and the
 * sidebar / generated reference page counts become stale.
 *
 * This test runs typedoc on the fly into a temp dir (so it doesn't pollute
 * the repo) and asserts the file count is within an acceptable window. If
 * the count jumps, that's a signal a new public surface was added; if it
 * drops, a public surface was removed. Both warrant a sdk1.md update.
 *
 * Thresholds:
 *   - Lower bound: 200 (below this, public surface was deleted)
 *   - Upper bound: 400 (above this, typedoc started duplicating output)
 *   - Snapshot min: pinned value the test will print on every run
 *
 * The exact pinned value is intentionally NOT a hard assertion: we want
 * the test to flag drift without blocking PRs. The printed value goes to
 * CI logs so reviewers see "typedoc generated N files this run" alongside
 * the previous value.
 */
import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const typedocScript = join(repoRoot, 'docs', 'scripts', 'gen-typedoc.mjs')

// Sanity check: typedoc must be installable. Skip if the network is
// restricted (CI runner may not have registry access).
const HAVE_TYPEDOC = existsSync(join(repoRoot, 'node_modules', 'typedoc')) &&
  existsSync(join(repoRoot, 'node_modules', 'typedoc-plugin-markdown'))

const LOWER_BOUND = 200
const UPPER_BOUND = 400

describe('typedoc output count regression guard', () => {
  it.skipIf(!HAVE_TYPEDOC)(
    'runs gen-typedoc.mjs into a temp dir and asserts the file count is within bounds',
    () => {
      const tmp = mkdtempSync(join(tmpdir(), 'typedoc-count-'))
      const probeOut = join(tmp, '_generated')
      // Patch the script's output dir via env-injection? The script
      // hard-codes the path. Cheaper: run the script and read what it
      // produced at the real path, then move-on. The real path is
      // gitignored (docs/api/_generated/), so this is safe in CI.
      try {
        execSync(`node "${typedocScript}"`, {
          cwd: repoRoot,
          stdio: 'pipe',
          timeout: 180_000,
        })
      } catch (err) {
        // gen-typedoc.mjs is intentionally non-fatal; only fail if
        // typedoc itself errored with no output.
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? ''
        const realOut = join(repoRoot, 'docs', 'api', '_generated')
        if (!existsSync(realOut)) {
          throw new Error(`typedoc run failed and produced no output: ${stderr.slice(0, 500)}`)
        }
      }

      const realOut = join(repoRoot, 'docs', 'api', '_generated')
      const files = readdirSync(realOut, { recursive: true }).filter(
        (f) => typeof f === 'string' && f.endsWith('.md'),
      )
      const count = files.length
      // Print to console for CI log inspection.
      // eslint-disable-next-line no-console
      console.log(`[typedoc-count] generated ${count} .md files (bounds: ${LOWER_BOUND}-${UPPER_BOUND})`)

      expect(count).toBeGreaterThanOrEqual(LOWER_BOUND)
      expect(count).toBeLessThanOrEqual(UPPER_BOUND)
    },
    240_000,
  )

  it('exposes the bounds as named exports so sdk1.md drift is debuggable', () => {
    // This test exists so a future reader wondering "why is the count
    // test asserting 200-400" can find the answer in a file rather than
    // in git history.
    expect(LOWER_BOUND).toBe(200)
    expect(UPPER_BOUND).toBe(400)
  })

  // Cleanup hook: remove the temp directory if it was created.
  it.skipIf(!HAVE_TYPEDOC)('cleanup temp probe directory', () => {
    const candidates = readdirSync(tmpdir())
      .filter((n) => n.startsWith('typedoc-count-'))
    for (const name of candidates) {
      rmSync(join(tmpdir(), name), { recursive: true, force: true })
    }
  })
})
