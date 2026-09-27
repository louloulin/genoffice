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
// The web-server's static route derives its allow-list from
// `scripts/sdk-entries.json` (written by build.mjs), so that manifest is
// copied alongside the bundles and every declared entry is served without
// touching src/index.ts. Adding a new sub-path is a one-line change to the
// `targets` array in build.mjs.

import { mkdirSync, copyFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sdkRoot = resolve(__dirname, '..')
const sdkDist = resolve(sdkRoot, 'dist')
const webserverRoot = resolve(sdkRoot, '..', 'web-server')
const target = resolve(webserverRoot, 'dist', 'static', 'sdk')
const manifest = resolve(__dirname, 'sdk-entries.json')

if (!existsSync(sdkDist)) {
  console.error(`[sdk→webserver] source dist/ missing at ${sdkDist}; did the build run?`)
  process.exit(1)
}
if (!existsSync(manifest)) {
  console.error(`[sdk→webserver] entry manifest missing at ${manifest}; did build.mjs run?`)
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
// The manifest travels with the bundles: the server reads it at startup to
// verify every declared entry was actually shipped.
copyFileSync(manifest, join(target, 'sdk-entries.json'))
copied++

console.log(`[sdk→webserver] copied ${copied} files from ${sdkDist} → ${target}`)