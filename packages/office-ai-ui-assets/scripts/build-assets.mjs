/**
 * Copy the four renderer bundles into this package so `npm publish` ships them.
 *
 * `apps/<app>/out/renderer` is gitignored build output, so it cannot be
 * committed — it has to be regenerated and staged at publish time. A missing or
 * half-copied app dir is fatal rather than skipped: the whole point of this
 * package is that a consumer gets working assets, and an assets package that
 * publishes empty directories fails only much later, as a blank editor in
 * someone else's browser.
 *
 * Layout matches what `@genoffice/office-ai` resolves
 * (`src/ui/assets.ts`: `dirname(require.resolve('<pkg>/package.json'))` + app).
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')

/** Must stay in lockstep with `UI_APPS` in packages/office-ai/src/ui/assets.ts. */
const APPS = ['docs', 'sheets', 'slides', 'pdf']

const missing = []
const staged = []

for (const app of APPS) {
  const source = join(REPO_ROOT, 'apps', app, 'out', 'renderer')
  const dest = join(PKG_ROOT, app)
  if (!existsSync(join(source, 'index.html'))) {
    missing.push(app)
    continue
  }
  // Clear first: content-hashed asset filenames mean a stale bundle leaves
  // orphans that still get packed, and the renderer keeps requesting them.
  rmSync(dest, { recursive: true, force: true })
  cpSync(source, dest, { recursive: true })
  staged.push([app, walk(dest)])
}

for (const [app, size] of staged) console.log(`  ${app.padEnd(8)} ${(size / 1024 / 1024).toFixed(1)} MB`)

if (missing.length) {
  console.error(
    `\nNo renderer build for: ${missing.join(', ')}\n` +
      `Build them first:  npm run build -w @genoffice/${missing[0]}\n` +
      `Or build all four:  npm run build:all`,
  )
  process.exit(1)
}

console.log(`\noffice-ai-ui-assets: staged ${staged.length} app bundles`)

function walk(target) {
  const stats = statSync(target)
  if (!stats.isDirectory()) return stats.size
  let total = 0
  for (const entry of readdirSync(target)) total += walk(join(target, entry))
  return total
}
