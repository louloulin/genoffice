/**
 * /api/v1/meta — health and changelog endpoints.
 *
 * Public (no auth required). The same `/health` body the existing
 * `/health` route returns is exposed here for clients that prefer
 * the v1 path. The changelog endpoint reads `apps/web-server/CHANGELOG.md`
 * if present and returns the most recent entries.
 * @public
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendJson, sendError } from './http-utils'
import { handlerCount, listChannels } from '../../common/index'

// ESM builds don't expose __dirname; derive it from import.meta.url. The
// fallback handles the CommonJS case (when bundled by esbuild as a single
// script without import.meta available).
//
// Two layout modes the function reconciles:
//
//   - bundle:    apps/web-server/dist/bundle/index.js           (4 levels up)
//   - source:    apps/web-server/src/api/v1/meta.ts            (5 levels up)
//
// We probe for the apps/web-server/CHANGELOG.md marker (a stable file
// that lives next to the bundle) and walk the dirname until the parent
// holds the file. This makes /api/v1/changelog resolve correctly both
// for the production bundle and for `npx tsx src/index.ts` development
// runs, where the previous hard-coded 4-up walk landed in apps/ and the
// endpoint answered 404.
function getPkgRoot(): string {
  try {
    const url = fileURLToPath(import.meta.url)
    const start = dirname(url)
    // Walk up at most 6 levels looking for the apps/web-server marker.
    // The marker file is the changelog itself, which lives directly
    // inside apps/web-server/. From any source/bundle path nested inside
    // the web-server tree we walk until the *current dir* is the
    // apps/web-server/ directory; one more step up is the monorepo root.
    let dir = start
    for (let i = 0; i < 6; i++) {
      // Check if `dir` is the apps/web-server/ directory itself.
      const markerHere = join(dir, 'CHANGELOG.md')
      const pkgJsonHere = join(dir, 'package.json')
      if (existsSync(markerHere) && existsSync(pkgJsonHere)) {
        // `dir` = apps/web-server/. The monorepo root is two levels up
        // (apps/web-server → apps → repo).
        return join(dir, '..', '..')
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    // Fallback: assume 4-up (bundle layout). The previous behaviour; left
    // in place so an unexpected tree (e.g. tests stubbing the FS) still
    // gets a sensible default.
    return join(start, '..', '..', '..', '..')
  } catch {
    return process.cwd()
  }
}

const PKG_ROOT = getPkgRoot()

/**
 * Public health check — returns implementation metadata.
 *
 * @route GET /api/v1/health
 * @summary (see above)
 * @scope —
 * @errors —
 * @public
 */
export function handleHealth(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  sendJson(ctx.response, 200, {
    status: 'ok',
    apiVersion: 'v1',
    implementedChannels: handlerCount(),
    channels: listChannels(),
    auth: process.env.GENOFFICE_JWT_SECRET ? 'jwt' : 'open',
    timestamp: new Date().toISOString(),
  })
  return true
}

/**
 * Public changelog endpoint.
 *
 * @route GET /api/v1/changelog
 * @summary (see above)
 * @scope —
 * @errors —
 * @public
 */
export function handleChangelog(ctx: { request: IncomingMessage; response: ServerResponse }): boolean {
  const candidates = [
    join(PKG_ROOT, 'CHANGELOG.md'),
    join(PKG_ROOT, 'apps', 'web-server', 'CHANGELOG.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf8')
        sendJson(ctx.response, 200, { format: 'markdown', content: text })
        return true
      } catch {
        /* fall through */
      }
    }
  }
  sendError(ctx.response, 404, 'changelog not found', 'NOT_FOUND', 'meta:changelog')
  return true
}
