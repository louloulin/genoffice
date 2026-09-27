/**
 * Boot-time self-checks (sdk1.md §11.125).
 *
 * These checks replaced a boot-log *warning* that detected the same broken
 * states and then started anyway — the "green locally, 404 in the deployment"
 * shape that let a released image ship with no renderer bundles and no SDK
 * bytes. The load-bearing property is therefore not "detects the problem" but
 * "refuses to serve", so each case below asserts a problem is reported, and
 * the healthy case asserts none is.
 *
 * `paths.ts` resolves STATIC_ROOT / SDK_BUNDLE_ROOT / HOST at import time, so
 * every case re-imports the module under stubbed env with a throwaway tree
 * built in tmp.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APPS = ['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html', 'shell']

type Checks = typeof import('../src/common/startup-checks')

interface Tree {
  root: string
  staticRoot: string
  sdkRoot: string
}

/** Build `<root>/apps/<app>/out/renderer/index.html` for every app plus a
 *  complete staged SDK. `omitSdkFiles` drops specific filenames afterwards so
 *  a case can model a partially-copied bundle directory. */
function buildTree(omitSdkFiles: string[] = []): Tree {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-startup-'))
  const staticRoot = join(root, 'apps')
  const sdkRoot = join(root, 'sdk')
  for (const app of APPS) {
    const dir = join(staticRoot, app, 'out', 'renderer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<!doctype html>')
  }
  mkdirSync(sdkRoot, { recursive: true })
  const entries = [
    { entry: 'src/index.ts', out: 'index', umd: true },
    { entry: 'src/file/jwt.ts', out: 'file-jwt', umd: false },
  ]
  writeFileSync(join(sdkRoot, 'sdk-entries.json'), JSON.stringify({ version: 1, entries }))
  for (const e of entries) {
    const names = [`${e.out}.mjs`, `${e.out}.cjs`, ...(e.umd ? [`${e.out}.umd.js`] : [])]
    for (const n of names) {
      if (omitSdkFiles.includes(n)) continue
      writeFileSync(join(sdkRoot, n), '// bundle')
    }
  }
  return { root, staticRoot, sdkRoot }
}

async function loadChecks(tree: Tree, env: Record<string, string>): Promise<Checks> {
  vi.resetModules()
  vi.stubEnv('DATA_DIR', join(tree.root, 'data'))
  vi.stubEnv('WEB_STATIC_ROOT', tree.staticRoot)
  vi.stubEnv('WEB_SDK_BUNDLE_DIR', tree.sdkRoot)
  vi.stubEnv('HOST', '127.0.0.1')
  vi.stubEnv('WEB_TOKEN', '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('../src/common/startup-checks')
}

const trees: Tree[] = []
function tree(omit: string[] = []): Tree {
  const t = buildTree(omit)
  trees.push(t)
  return t
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const t of trees.splice(0)) rmSync(t.root, { recursive: true, force: true })
})

describe('isLoopbackHost', () => {
  it('accepts only addresses reachable from this machine alone', async () => {
    const { isLoopbackHost } = await loadChecks(tree(), {})
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(host), host).toBe(true)
    }
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.internal', '[::]']) {
      expect(isLoopbackHost(host), host).toBe(false)
    }
  })
})

describe('sdkEntryFileNames', () => {
  it('expands a UMD entry to three files and a plain entry to two', async () => {
    const { sdkEntryFileNames } = await loadChecks(tree(), {})
    expect(sdkEntryFileNames({ entry: 'src/index.ts', out: 'index', umd: true })).toEqual([
      'index.mjs',
      'index.cjs',
      'index.umd.js',
    ])
    expect(sdkEntryFileNames({ entry: 'src/a.ts', out: 'a', umd: false })).toEqual([
      'a.mjs',
      'a.cjs',
    ])
  })
})

describe('collectStartupProblems', () => {
  it('reports nothing for a complete tree on a loopback bind', async () => {
    const t = tree()
    const { collectStartupProblems } = await loadChecks(t, {})
    expect(collectStartupProblems()).toEqual([])
  })

  it('reports a declared SDK file that was never staged', async () => {
    const t = tree(['file-jwt.cjs'])
    const { collectStartupProblems } = await loadChecks(t, {})
    const problems = collectStartupProblems()
    expect(problems).toHaveLength(1)
    expect(problems[0]!.check).toBe('sdk bundle files')
    expect(problems[0]!.detail).toContain('file-jwt.cjs')
  })

  it('reports a missing manifest as a missing SDK build, not a crash', async () => {
    const t = tree()
    rmSync(join(t.sdkRoot, 'sdk-entries.json'))
    const { collectStartupProblems } = await loadChecks(t, {})
    const problems = collectStartupProblems()
    expect(problems.map((p) => p.check)).toContain('sdk manifest')
  })

  it('reports a malformed manifest rather than serving an empty allow-list', async () => {
    const t = tree()
    writeFileSync(join(t.sdkRoot, 'sdk-entries.json'), JSON.stringify({ version: 1 }))
    const { collectStartupProblems } = await loadChecks(t, {})
    expect(collectStartupProblems().map((p) => p.check)).toContain('sdk manifest')
  })

  it('reports an app whose renderer bundle is absent', async () => {
    const t = tree()
    rmSync(join(t.staticRoot, 'slides'), { recursive: true, force: true })
    const { collectStartupProblems } = await loadChecks(t, {})
    const problems = collectStartupProblems()
    expect(problems).toHaveLength(1)
    expect(problems[0]!.check).toBe('renderer bundles')
    expect(problems[0]!.detail).toContain('slides')
  })

  it('refuses a non-loopback bind with no shared secret', async () => {
    const t = tree()
    const { collectStartupProblems } = await loadChecks(t, { HOST: '0.0.0.0' })
    const problems = collectStartupProblems()
    expect(problems).toHaveLength(1)
    expect(problems[0]!.check).toBe('auth posture')
  })

  it('accepts a non-loopback bind once WEB_TOKEN is armed', async () => {
    const t = tree()
    const { collectStartupProblems } = await loadChecks(t, {
      HOST: '0.0.0.0',
      WEB_TOKEN: 'x'.repeat(32),
    })
    expect(collectStartupProblems()).toEqual([])
  })
})
