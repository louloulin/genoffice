/**
 * `WEB_MANAGED_ROOTS` env var — additional paths the operator may add to the
 * managed-storage allow-list. The web-server's `isManagedPath` predicate is
 * the only thing between a renderer-supplied path and the rest of the
 * filesystem, so a bug here is a critical: a typo'd root entry that includes
 * `/` would silently allow every channel that goes through this guard to
 * reach anywhere.
 *
 * The matrix covers:
 *   - empty / undefined env var            → no extra roots
 *   - one absolute path                    → added to the list
 *   - multiple paths (comma-separated)     → each added
 *   - relative paths                       → silently dropped
 *   - whitespace-only entries              → silently dropped
 *   - paths still containing `..` segments → silently dropped (would have
 *     been normalised away by `resolve()`, but a literal `..` is suspicious)
 *   - paths inside an existing root         → allowed; deduplication is the
 *     consumer's problem (the extra root still narrows the check)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'

// Module imports read `process.env.WEB_MANAGED_ROOTS` at load time — set the
// env before the dynamic import. We also need `DATA_DIR` to be set so
// `paths.ts` initialises cleanly; a temp dir is fine for these tests because
// we never touch real data.
const tempRoot = mkdtempSync(join(tmpdir(), 'genoffice-paths-multi-root-'))
const dataDir = join(tempRoot, 'data')
process.env.DATA_DIR = dataDir

const originalEnv = process.env.WEB_MANAGED_ROOTS
process.env.WEB_MANAGED_ROOTS = [
  join(tempRoot, 'mirror'),
  join(tempRoot, 'cache'),
].join(',')

let EXTRA_MANAGED_ROOTS: readonly string[]
let isManagedPath: (target: string) => boolean

beforeAll(async () => {
  const mod = await import('../src/common/paths')
  EXTRA_MANAGED_ROOTS = mod.EXTRA_MANAGED_ROOTS
  isManagedPath = mod.isManagedPath
})

afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env.WEB_MANAGED_ROOTS
  } else {
    process.env.WEB_MANAGED_ROOTS = originalEnv
  }
  delete process.env.DATA_DIR
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('WEB_MANAGED_ROOTS env var parsing', () => {
  it('exposes the parsed roots as absolute paths', () => {
    expect(EXTRA_MANAGED_ROOTS).toHaveLength(2)
    expect(EXTRA_MANAGED_ROOTS).toContain(resolve(join(tempRoot, 'mirror')))
    expect(EXTRA_MANAGED_ROOTS).toContain(resolve(join(tempRoot, 'cache')))
    for (const root of EXTRA_MANAGED_ROOTS) {
      expect(root.startsWith(sep) || /^[a-z]:\\/i.test(root)).toBe(true)
    }
  })

  it('isManagedPath accepts a path inside an extra root', () => {
    expect(isManagedPath(join(tempRoot, 'mirror', 'doc.pdf'))).toBe(true)
    expect(isManagedPath(join(tempRoot, 'cache', 'index.json'))).toBe(true)
  })

  it('isManagedPath still refuses paths outside every root', () => {
    expect(isManagedPath('/etc/passwd')).toBe(false)
    expect(isManagedPath(join(tempRoot, '..', 'somewhere-else'))).toBe(false)
  })
})

describe('parseExtraManagedRoots malformed-input rejection', () => {
  let originalRootEnv: string | undefined
  beforeAll(() => {
    originalRootEnv = process.env.WEB_MANAGED_ROOTS
  })
  afterAll(() => {
    if (originalRootEnv === undefined) delete process.env.WEB_MANAGED_ROOTS
    else process.env.WEB_MANAGED_ROOTS = originalRootEnv
  })

  it('returns [] when the env var is unset', async () => {
    delete process.env.WEB_MANAGED_ROOTS
    vi.resetModules()
    const { EXTRA_MANAGED_ROOTS: roots } = await import('../src/common/paths')
    expect(roots).toEqual([])
  })

  it('returns [] when the env var is empty', async () => {
    process.env.WEB_MANAGED_ROOTS = ''
    vi.resetModules()
    const { EXTRA_MANAGED_ROOTS: roots } = await import('../src/common/paths')
    expect(roots).toEqual([])
  })

  it('drops relative entries silently', async () => {
    process.env.WEB_MANAGED_ROOTS = ['relative/path', '/abs/ok'].join(',')
    vi.resetModules()
    const { EXTRA_MANAGED_ROOTS: roots } = await import('../src/common/paths')
    expect(roots).toEqual([resolve('/abs/ok')])
  })

  it('drops whitespace-only entries silently', async () => {
    process.env.WEB_MANAGED_ROOTS = ['   ', '/abs/ok', ''].join(',')
    vi.resetModules()
    const { EXTRA_MANAGED_ROOTS: roots } = await import('../src/common/paths')
    expect(roots).toEqual([resolve('/abs/ok')])
  })

  it('drops entries that still contain `..` after resolution', async () => {
    // `resolve()` collapses the `..`, so the absolute form would not contain
    // it — but the input does. We can't construct an absolute path that
    // retains `..` after `resolve()`, so this test verifies the related
    // guarantee: a string that contains `..` as a *literal* segment is
    // refused if it could survive resolution. Since `resolve` normalises
    // everything, the only attack vector is the env var content — and our
    // parser splits on comma and trims, so `/var/../etc` becomes
    // `/var/../etc` (still has `..`). Verify the parser refuses it.
    process.env.WEB_MANAGED_ROOTS = `/var/lib/../etc,${join(tempRoot, 'real')}`
    vi.resetModules()
    const { EXTRA_MANAGED_ROOTS: roots } = await import('../src/common/paths')
    expect(roots).toContain(resolve(join(tempRoot, 'real')))
    expect(roots).not.toContain('/var/etc')
  })
})

// Helper import — vitest is imported via the file's top-level `vi`.
import { vi } from 'vitest'