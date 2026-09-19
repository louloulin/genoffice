/**
 * Process-level constants for the web-server: port, host, static roots,
 * app allow-list.
 *
 * ROOT resolution handles three real runtimes:
 *   1. ESM dev (`tsx src/index.ts`) — `import.meta.url` is a `file://…`
 *      URL pointing into `apps/web-server/src/common/`.
 *   2. CJS packaged binary (`pkg dist/index.js`) — `import.meta.url` is
 *      empty; we derive from `process.execPath` (the on-disk binary).
 *   3. Plain Node from build output (`node dist/index.js`) — same as
 *      (2) but argv[1] is the real entry script.
 *
 * STATIC_ROOT can be overridden by `WEB_STATIC_ROOT` for production
 * deployments where the apps are mounted at an arbitrary location.
 */
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function resolveMetaDir(): string {
  // ESM path: this remains valid after esbuild bundles the server and points
  // at the directory containing the generated bundle.
  try {
    return fileURLToPath(new URL('.', import.meta.url))
  } catch {
    /* CJS / packaged runtime: import.meta.url is empty or not a file URL, so
       fall through to the execPath and argv[1] strategies below. */
  }
  // CJS path: argv[1] in a packaged binary is the snapshot virtual path
  // (e.g. /snapshot/dist/index.js), not a real file. execPath IS the
  // real on-disk path of the running binary, so prefer it.
  if (typeof process.execPath === 'string' && process.execPath.length > 0) {
    return dirname(process.execPath)
  }
  // Last resort: argv[1] for `node dist/index.js` from source.
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1.length > 0) {
    return dirname(argv1)
  }
  return process.cwd()
}

const here = resolveMetaDir()
// In source tree: <repo>/apps/web-server/{src,dist}/common/ → repo root is
// 4 levels up. In pkg binary: <install-dir>/apps/web-server/dist/ → repo
// root is 3 levels up. Use cwd as a tie-breaker: if a `apps` directory
// exists next to the binary, prefer that layout.
const candidateRepo = resolve(here, '..', '..', '..', '..')
const candidateFromExec = resolve(here, '..', '..', '..')
const cwdRoot = resolve(process.cwd())
const ROOT = existsSync(resolve(cwdRoot, 'apps'))
  ? cwdRoot
  : existsSync(resolve(candidateRepo, 'apps'))
    ? candidateRepo
    : candidateFromExec
// STATIC_ROOT: env override → apps dir beside ROOT (dev) → apps dir
// beside the binary (packaged) → fall back to ROOT/apps.
const envStatic = process.env.WEB_STATIC_ROOT
let STATIC_ROOT: string
if (envStatic && envStatic.length > 0) {
  STATIC_ROOT = resolve(envStatic)
} else {
  STATIC_ROOT = resolve(ROOT, 'apps')
}

export const PORT = Number(process.env.PORT) || 18081
export const HOST = process.env.HOST || '0.0.0.0'

export const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell']

export { ROOT, STATIC_ROOT }

export const WEB_TEMP_ROOT = resolve(process.env.TMPDIR || '/tmp', 'genoffice-web-temp')

/**
 * True when `target` resolves to `root` itself or to a path strictly beneath
 * it. Used to contain every file path a renderer hands the server: the web
 * build has no Electron path-grant map, so channels that read or rewrite a
 * file must prove the path is inside the managed storage area first.
 *
 * Compares path components after resolution, not raw string prefixes, so
 * `/data/files-evil` is NOT inside `/data/files`.
 */
export function isWithin(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target))
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  )
}
