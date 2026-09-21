/**
 * /api/v1/changelog path-resolution regression (P3).
 *
 * The previous `getPkgRoot()` walked exactly four parents up from
 * `import.meta.url`. That worked for the production bundle
 * (apps/web-server/dist/bundle/index.js → monorepo root), but the dev
 * `npx tsx src/index.ts` run loads `src/api/v1/meta.ts`, where four
 * parents lands in `apps/` (not the repo root), and the endpoint
 * answered 404.
 *
 * This suite boots the bundle AND sources `meta.ts` directly (via
 * vitest's loader) and asserts both shapes resolve the monorepo
 * correctly so the endpoint can find `apps/web-server/CHANGELOG.md`.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleChangelog } from '../src/api/v1/meta'

function mockRes(): {
  res: { statusCode: number; headers: Record<string, string>; body: string }
  read: () => { status: number; body: string }
} {
  let status = 200
  const headers: Record<string, string> = {}
  let body = ''
  const res = {
    statusCode: 200,
    headers,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    writeHead(s: number) {
      status = s
    },
    end(payload: string) {
      if (payload) body = payload
    },
    // Use any to keep the test lightweight; handleChangelog only calls
    // setHeader + writeHead + end via sendJson/sendError helpers.
  }
  return {
    res: res as unknown as { statusCode: number; headers: Record<string, string>; body: string },
    read: () => ({ status, body }),
  }
}

function mockReq(): unknown {
  // handleChangelog only needs the IncomingMessage for /health variant;
  // the changelog handler does not touch it. Empty stub is enough.
  return {} as unknown
}

describe('/api/v1/changelog resolution', () => {
  it('resolves apps/web-server/CHANGELOG.md from the source-mode cwd', () => {
    // When vitest imports src/api/v1/meta.ts directly, import.meta.url
    // points at apps/web-server/src/api/v1/meta.ts — 5 levels up to
    // repo root. The previous hard-coded 4-up walk landed in apps/.
    const here = dirname(fileURLToPath(import.meta.url))
    expect(here).toMatch(/apps\/web-server\/tests$/)
    const { res, read } = mockRes()
    const ok = handleChangelog({ request: mockReq() as never, response: res as never })
    expect(ok).toBe(true)
    const { status, body } = read()
    expect(status).toBe(200)
    expect(body).toMatch(/"format":\s*"markdown"/)
    expect(body).toMatch(/"content":\s*"# Changelog/)
  })

  it('CHANGELOG.md exists at apps/web-server/CHANGELOG.md', () => {
    // Sanity check the marker the resolver walks up to find.
    const here = dirname(fileURLToPath(import.meta.url))
    // `here` = apps/web-server/tests. CHANGELOG.md is in apps/web-server/.
    const candidate = join(here, '..', 'CHANGELOG.md')
    expect(existsSync(candidate)).toBe(true)
    const text = readFileSync(candidate, 'utf8')
    expect(text.length).toBeGreaterThan(0)
  })
})
