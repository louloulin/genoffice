/**
 * Renderer alias-order guard (regression for a real build break).
 *
 * Every editor app resolves `@genoffice/ipc-bridge/*` to this checkout's
 * sources so a git worktree can't silently bundle a stale copy from
 * `node_modules` (which is a symlink into the main checkout). Vite treats
 * string aliases as *prefix replacements*, so the bare
 *
 *     '@genoffice/ipc-bridge' → …/src/index.ts
 *
 * entry MUST come after every subpath entry. When it doesn't,
 * `'@genoffice/ipc-bridge/sidebar-runtime'` resolves to
 * `…/src/index.ts/sidebar-runtime` and the renderer build dies with
 * ENOTDIR — which is exactly what happened before this guard existed.
 *
 * `apps/html` had no alias block at all, so its renderer kept bundling a
 * pre-sidebar copy of the bridge from `node_modules` even after the other
 * five apps were fixed. The test pins both facts:
 *   1. every editor app declares the alias block, and
 *   2. inside it, subpaths precede the bare specifier.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Apps that render an editor SPA and therefore import the bridge. */
const EDITOR_APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'] as const

/** Subpaths the renderers actually import today. */
const REQUIRED_SUBPATHS = [
  '@genoffice/ipc-bridge/client',
  '@genoffice/ipc-bridge/web-native',
  '@genoffice/ipc-bridge/web-tabs',
  '@genoffice/ipc-bridge/sdk-command-sink',
  '@genoffice/ipc-bridge/text-buffer-adapter',
  '@genoffice/ipc-bridge/sidebar-runtime',
] as const

const ROOT = join(__dirname, '..', '..', '..')

function configPath(app: string): string {
  return join(ROOT, 'apps', app, 'electron.vite.config.ts')
}

function readConfig(app: string): string {
  const p = configPath(app)
  expect(existsSync(p), `${app}: missing electron.vite.config.ts`).toBe(true)
  return readFileSync(p, 'utf8')
}

/** Index of the first line that contains `needle`, or -1. */
function lineIndex(source: string, needle: string): number {
  const lines = source.split('\n')
  return lines.findIndex((l) => l.includes(needle))
}

describe('renderer alias order (bridge subpaths before bare specifier)', () => {
  for (const app of EDITOR_APPS) {
    it(`${app}: declares every ipc-bridge subpath alias`, () => {
      const source = readConfig(app)
      for (const sub of REQUIRED_SUBPATHS) {
        expect(source, `${app}: missing alias for ${sub}`).toContain(`'${sub}'`)
      }
    })

    it(`${app}: lists the bare ipc-bridge alias after every subpath`, () => {
      const source = readConfig(app)
      const bareIdx = lineIndex(source, "'@genoffice/ipc-bridge':")
      expect(bareIdx, `${app}: no bare '@genoffice/ipc-bridge' alias line`).toBeGreaterThanOrEqual(0)

      for (const sub of REQUIRED_SUBPATHS) {
        const subIdx = lineIndex(source, `'${sub}':`)
        expect(subIdx, `${app}: no alias line for ${sub}`).toBeGreaterThanOrEqual(0)
        expect(
          subIdx,
          `${app}: '${sub}' is declared after the bare '@genoffice/ipc-bridge' alias; ` +
            'vite prefix-replacement will rewrite it to src/index.ts/<subpath> and the ' +
            'renderer build will fail with ENOTDIR',
        ).toBeLessThan(bareIdx)
      }
    })

    it(`${app}: excludes ipc-bridge from dep externalization`, () => {
      // A renderer that externalizes @genoffice/ipc-bridge ships an
      // unresolved bare import to the browser. The workspace packages ship
      // raw TS, so they must be bundled.
      const source = readConfig(app)
      expect(source).toContain("'@genoffice/ipc-bridge'")
      expect(source).toMatch(/exclude:\s*\[[^\]]*'@genoffice\/ipc-bridge'/)
    })
  }
})
