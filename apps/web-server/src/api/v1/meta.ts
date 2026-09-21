/**
 * /api/v1/meta — health and changelog endpoints.
 *
 * Public (no auth required). The same `/health` body the existing
 * `/health` route returns is exposed here for clients that prefer
 * the v1 path. The changelog endpoint reads `apps/web-server/CHANGELOG.md`
 * if present and returns the most recent entries.
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
function getPkgRoot(): string {
  try {
    const url = fileURLToPath(import.meta.url)
    // Bundle lives at apps/web-server/dist/bundle/index.js; we want the
    // monorepo root which is four parents up.
    return join(dirname(url), '..', '..', '..', '..')
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
