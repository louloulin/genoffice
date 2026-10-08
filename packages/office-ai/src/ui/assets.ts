/**
 * Renderer asset resolution for the loopback UI host. Three-tier chain:
 *   1. explicit `assetsDir` from the caller,
 *   2. require.resolve('@genoffice/office-ai-ui-assets') — the separately
 *      published asset package keyed by app name,
 *   3. submodule sibling path `<repo>/apps/<app>/out/renderer` for in-repo
 *      consumers (dev/CI).
 * The UI assets are NOT shipped inside the office-ai tarball (62 MB across
 * the four apps), so tier 2 is the production path.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type UiApp = 'docs' | 'sheets' | 'slides' | 'pdf'

export const UI_APPS: readonly UiApp[] = ['docs', 'sheets', 'slides', 'pdf']

const UI_ASSETS_PACKAGE = '@genoffice/office-ai-ui-assets'

export interface AssetsResolver {
  /** Directory containing the compiled renderer bundle for one app, or null. */
  resolveAppDir(app: UiApp): string | null
}

/**
 * @param explicitAssetsDir root that contains per-app renderer dirs
 *   (`docs/`, `sheets/`, …). When given, tiers 2/3 are skipped.
 */
export function createAssetsResolver(explicitAssetsDir?: string): AssetsResolver {
  const explicitRoot = explicitAssetsDir ? resolve(explicitAssetsDir) : null
  let packageRoot: string | null | undefined

  function resolvePackageRoot(): string | null {
    if (packageRoot !== undefined) return packageRoot
    packageRoot = null
    try {
      const require = createRequire(getSelfModuleBase())
      packageRoot = dirname(require.resolve(`${UI_ASSETS_PACKAGE}/package.json`))
    } catch {
      /* not installed — fall through to tier 3 */
    }
    return packageRoot
  }

  return {
    resolveAppDir(app) {
      if (explicitRoot) {
        const dir = join(explicitRoot, app)
        return existsSync(dir) ? dir : null
      }
      const pkgRoot = resolvePackageRoot()
      if (pkgRoot) {
        const dir = join(pkgRoot, app)
        if (existsSync(dir)) return dir
      }
      // Tier 3: sibling checkout — dist/host.cjs lives in
      // packages/office-ai/dist, so three ups reach the repo root.
      const sibling = join(getSelfModuleBase(), '..', '..', '..', 'apps', app, 'out', 'renderer')
      const resolved = resolve(sibling)
      return existsSync(resolved) ? resolved : null
    },
  }
}

/** Directory of the module this file compiles into (CJS bundle = dist/). */
function getSelfModuleBase(): string {
  return dirname(
    typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url),
  )
}