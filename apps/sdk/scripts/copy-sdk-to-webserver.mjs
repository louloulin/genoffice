// Build-pipeline bridge: copy the freshly-built SDK bundles from
// `apps/sdk/dist/` into `apps/web-server/dist/static/sdk/` so the
// web-server's `/static/sdk/*` route (src/index.ts:1132) can serve them
// without a manual copy step.
//
// This closes plan §6.1 B.6: previously every host had to copy the SDK
// bundle out-of-band, which caused version drift between the embed iframe
// (loading from the host's CDN) and the web-server (where the SDK was
// actually built).
//
// Run via: `apps/sdk/package.json#scripts.build`
//
//   node scripts/build.mjs && node scripts/copy-sdk-to-webserver.mjs
//
// The web-server's static route allow-lists explicit filenames (see
// `if (url.pathname === '/static/sdk/index.mjs' || ...)` in src/index.ts);
// when adding a new sub-path here, also extend the allow-list there.

import { mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(__dirname, '..')
const sdkDist = resolve(sdkRoot, 'dist')
const webserverRoot = resolve(sdkRoot, '..', 'web-server')
const target = resolve(webserverRoot, 'dist', 'static', 'sdk')

if (!existsSync(sdkDist)) {
  console.error(`[sdk→webserver] source dist/ missing at ${sdkDist}; did the build run?`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
// Wipe stale copies so a deleted entry doesn't linger.
for (const f of readdirSync(target)) {
  rmSync(join(target, f), { force: true })
}

let copied = 0
for (const f of readdirSync(sdkDist)) {
  if (/\.(mjs|cjs|umd\.js|d\.ts|d\.ts\.map|js\.map)$/.test(f)) {
    copyFileSync(join(sdkDist, f), join(target, f))
    copied++
  }
}

console.log(`[sdk→webserver] copied ${copied} files from ${sdkDist} → ${target}`)