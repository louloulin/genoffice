#!/usr/bin/env node
/**
 * gen-typedoc.mjs — generate REST API documentation from JSDoc on the
 * web-server's IPC + REST handlers.
 *
 * Output: docs/api/_generated/ (referenced from docs/.vitepress/config.ts).
 *
 * Strategy:
 *   1. Run typedoc against apps/web-server/src with the markdown plugin
 *      so the result is plain .md we can ship.
 *   2. Wipe the previous _generated/ tree so removed symbols disappear.
 *   3. typedoc failure is non-fatal: the manual docs still ship and CI
 *      logs the warning.
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..')
const webServer = join(repo, 'apps', 'web-server')
const outDir = join(repo, 'docs', 'api', '_generated')

if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

console.log('[typedoc] scanning', webServer)

const args = [
  'npx --yes typedoc',
  '--plugin typedoc-plugin-markdown',
  '--out ' + outDir,
  '--entryPointStrategy expand',
  '--entryPoints ' + webServer + '/src/index.ts',
  '--entryPoints ' + webServer + '/src/api/v1',
  // Common helpers (webhooks, recents, files-store, etc.) need their own
  // entry point or typedoc warns that referenced types are not included.
  '--entryPoints ' + webServer + '/src/common',
  '--tsconfig ' + webServer + '/tsconfig.json',
  '--readme none',
  '--skipErrorChecking',
  '--hideGenerator',
  '--githubPages false',
  '--excludeInternal',
  '--excludePrivate',
  '--logLevel Warn',
].join(' ')

try {
  execSync(args, { stdio: 'inherit', cwd: repo })
  console.log('[typedoc] generated', outDir)
} catch (err) {
  console.warn('[typedoc] failed (non-fatal):', err.message)
  process.exit(0)
}
