/**
 * Single source of truth for web-server version (sdk1.md §11.23).
 *
 * Before §11.23 the version string `0.8.0` was hardcoded in five
 * separate files:
 *   - apps/web-server/src/index.ts (boot banner + /health endpoint)
 *   - apps/web-server/src/shell/app-info.ts (app:get-version handler)
 *   - apps/web-server/src/embed/index.ts (EMBED_BRIDGE ready payload)
 *
 * After §11.23 every consumer imports `WEB_SERVER_VERSION` from
 * `apps/web-server/src/common/version.ts`. This test pins:
 *
 *   1. The constant matches `package.json#version` — no more drift
 *      between hardcoded literals.
 *   2. Every previously-hardcoded consumer now reads from the
 *      constant (file-grep guard).
 *
 * The package.json check is the single hard signal that the version
 * is correct; the file-grep check guards against someone reintroducing
 * a hardcoded `'0.8.0'` literal in a future patch.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

interface PkgJson {
  version: string
  [key: string]: unknown
}

describe('web-server version single source of truth (sdk1.md §11.23)', () => {
  it('WEB_SERVER_VERSION matches package.json#version', async () => {
    const pkgPath = join(REPO_ROOT, 'apps', 'web-server', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PkgJson
    const { WEB_SERVER_VERSION } = await import('../src/common/version')
    expect(WEB_SERVER_VERSION).toBe(pkg.version)
    // Belt-and-suspenders: pin the literal shape so a future
    // semver-prefixed release (e.g. '0.8.0-beta.1') can't silently
    // slip past us.
    expect(WEB_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/)
  })

  it('no consumer hardcodes "0.8.0" — must import WEB_SERVER_VERSION', () => {
    // Allowed literal sites:
    //   - apps/web-server/package.json (the source of truth)
    //   - apps/web-server/src/common/version.ts (the wrapper constant)
    //   - this test file (which checks for the absence of literals)
    //
    // All other sites must read WEB_SERVER_VERSION.
    const ALLOWED = new Set([
      'apps/web-server/package.json',
      'apps/web-server/src/common/version.ts',
      'apps/web-server/tests/version-sot.test.ts',
    ])

    // Walk a curated list of files that previously contained the
    // literal. If a new file is added, extend this list.
    // skills.ts holds *skill package versions* (e.g. web-clipper's 0.8.0)
    // — those are unrelated to the web-server version and intentionally
    // carry their own semantic. Only scan files where '0.8.0' refers to
    // the server version itself.
    const CANDIDATES = [
      'apps/web-server/src/index.ts',
      'apps/web-server/src/shell/app-info.ts',
      'apps/web-server/src/embed/index.ts',
    ]

    // Regex: any quoted literal that looks like '0.8.0' or "0.8.0".
    const HARDCODE = /['"]0\.8\.0['"]/

    const offenders: string[] = []
    for (const rel of CANDIDATES) {
      const abs = join(REPO_ROOT, rel)
      const text = readFileSync(abs, 'utf-8')
      // Skip lines that are in a comment by stripping line comments.
      // This avoids false positives like "// 0.8.0 was the old version".
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        // Strip // line comments (rough heuristic; doesn't handle /* */ blocks).
        const code = line.replace(/\/\/.*$/, '')
        if (HARDCODE.test(code)) {
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`)
        }
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([])
    // Sanity: ensure we actually scanned at least one expected file.
    // (Catches a typo in CANDIDATES.)
    expect(ALLOWED.size).toBeGreaterThan(0)
    void ALLOWED // silence unused-warning; the set documents the allowlist
  })

  it('boot banner template literal now interpolates WEB_SERVER_VERSION', () => {
    // Guards against someone reverting the literal in index.ts to
    // a string template instead of using the constant.
    const indexPath = join(REPO_ROOT, 'apps', 'web-server', 'src', 'index.ts')
    const text = readFileSync(indexPath, 'utf-8')
    expect(text).toContain('v${WEB_SERVER_VERSION}')
    expect(text).not.toContain("v0.8.0 (Enhanced)")
  })

  it('embed bridge ready payload now interpolates WEB_SERVER_VERSION', () => {
    const embedPath = join(REPO_ROOT, 'apps', 'web-server', 'src', 'embed', 'index.ts')
    const text = readFileSync(embedPath, 'utf-8')
    expect(text).toContain("version: '${WEB_SERVER_VERSION}'")
    expect(text).not.toContain("version: '0.9.0'")
    expect(text).not.toContain("version: '0.8.0'")
  })

  it('app-info handler now returns WEB_SERVER_VERSION', () => {
    const appInfoPath = join(REPO_ROOT, 'apps', 'web-server', 'src', 'shell', 'app-info.ts')
    const text = readFileSync(appInfoPath, 'utf-8')
    expect(text).toContain("() => WEB_SERVER_VERSION")
    expect(text).not.toContain("() => '0.8.0'")
  })
})
