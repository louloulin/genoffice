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
import { DATA_DIR } from './state'
import { InvalidArgumentError } from '../ai/errors'

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
/**
 * Bind address for the HTTP listener. The web build is a developer
 * tool that ships an IPC bridge to a remote-controlled renderer
 * (`web:save-file`, `docs:open-path`, `web:read-file-bytes`); the
 * previous default of `0.0.0.0` exposed every channel to anyone
 * reachable on the LAN. Operators that need an external bind must
 * opt in explicitly with `HOST=0.0.0.0` (and should pair it with
 * `WEB_TOKEN` for the auth gate in `apps/web-server/src/auth/`).
 */
export const HOST = process.env.HOST || '127.0.0.1'

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

/**
 * True when `target` is a path this server is allowed to read, write, delete or
 * rename on a renderer's behalf: inside persistent storage (`DATA_DIR`, which
 * contains `FILES_DIR` where uploads and save-as targets land) or inside the
 * disposable upload area (`WEB_TEMP_ROOT`).
 *
 * In the web build there is no Electron path-grant map, so this predicate is
 * the only thing between a renderer — or anyone who can reach the IPC endpoint;
 * the default HOST binds every interface — and the rest of the filesystem.
 */
export function isManagedPath(target: string): boolean {
  return [DATA_DIR, WEB_TEMP_ROOT].some((root) => isWithin(root, target))
}

/**
 * The one rejection message for a path outside managed storage. Exported so
 * element-wise channels can report the same refusal as the ones that throw
 * InvalidArgumentError, and so tests can assert on a single string rather than
 * on each channel's phrasing.
 */
export const PATH_OUTSIDE_STORAGE = 'path is outside the web storage area'

/**
 * Validate a renderer-supplied file path for a channel that touches the disk.
 *
 * Every such channel should start with this call and pass the result (not the
 * raw argument) to `fs`: it rejects non-strings, which also stops the
 * `fs.existsSync(undefined)` deprecation warning that a missing argument used
 * to trigger, and it rejects any path outside managed storage.
 *
 * @throws InvalidArgumentError — a bad path is a client error (400), not a
 *   server fault, so a caller probing for `/etc/passwd` learns nothing more
 *   than that the path was refused.
 */
export function requireManagedPath(channel: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || !isManagedPath(value)) {
    throw new InvalidArgumentError(channel, PATH_OUTSIDE_STORAGE)
  }
  return value
}
/**
 * Reserved device names on Windows: a file literally named `CON`,
 * `PRN`, `AUX`, `NUL`, or `COM1`-`COM9` / `LPT1`-`LPT9` cannot be
 * opened on the OS even when only the basename is used. We refuse
 * them so a renderer-supplied name can never silently alias a host
 * device.
 */
export const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * Sanitize a renderer-supplied filename before it touches the disk.
 *
 * Goal: produce a single basename that is safe to use as a leaf name
 * (no path separators, no NUL, no platform-forbidden characters,
 * no control codes, no `..` siblings, no trailing dots/spaces, no
 * Windows-reserved device names) and produce an extension that maps
 * to a known MIME type so the saved file can be served back through
 * the static renderer.
 *
 * `name` is attacker-controlled. Without this, a renderer could
 * ship `..\u005C..\u005Cetc\u005Cpasswd` or `CON.docx` and the
 * previous code happily wrote it as a `web:save-file` artefact —
 * see `tests/managed-path-guard.test.ts` for the attack matrix and
 * `tests/paths-sanitize.test.ts` for the unit matrix.
 */
export function sanitizeFileName(name: unknown, fallback = 'file'): string {
  if (typeof name !== 'string' || name.length === 0) return fallback
  // Strip any directory components in one pass. `basename` does this
  // for both POSIX and Windows separators; we re-implement it here to
  // also strip NUL bytes and the rare look-alike Unicode separators
  // (\u2215 division slash, \uFF0F fullwidth solidus, \uFF3C fullwidth
  // reverse solidus) so the leaf cannot escape its parent directory.
  const stripped = name
    .replace(/[\u0000]/g, '')
    .split(/[\\\/∕／＼]/)
    .pop() ?? ''
  if (!stripped || stripped === '.' || stripped === '..') return fallback
  // Reserved chars: ASCII control codes, the C1 control block (0x7f),
  // and the platform-specific set (\ : * ? " < > |). Replace with `_`
  // rather than dropping so the user can see something happened.
  const cleaned = stripped.replace(/[\u0000-\u001f\u007f\\:*?"<>|]+/g, '_')
  // Windows drops trailing dots and trailing spaces on disk, which
  // would silently change the file name under the operator's feet.
  // Strip them BEFORE extracting the extension so 'foo.docx   ' becomes
  // 'foo.docx' (not 'fo.docx   ' with a corrupted stem).
  const trimmed = cleaned.replace(/[. ]+$/g, '') || cleaned
  const ext = extensionOf(trimmed).toLowerCase()
  const stemRaw = ext ? trimmed.slice(0, trimmed.length - ext.length) : trimmed
  const stem = stemRaw.replace(/[. ]+$/g, '')
  if (!stem) return fallback
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) return fallback
  return ext ? `${stem}${ext}` : stem
}

function extensionOf(value: string): string {
  const dot = value.lastIndexOf('.')
  if (dot <= 0) return ''
  // Hidden file with no extension (e.g. `.bashrc`) should keep the
  // leading dot — only treat `.` as the extension separator when it
  // is followed by at least one non-dot character.
  if (dot === value.length - 1) return ''
  return value.slice(dot)
}
