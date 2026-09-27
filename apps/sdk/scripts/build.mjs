// esbuild multi-entry build for the SDK.
//
// Each published sub-path under `package.json#exports` gets its own bundle
// (ESM + CJS + optional UMD). Sub-paths are deliberately independent so a
// host that only needs, say, the dataflare guest bridge doesn't pull in
// `createEditor` or the file-management surface.
//
//   entry                          out name             UMD global
//   src/index.ts                    index             GenOffice
//   src/dataflare/host.ts           dataflare-host    GenOfficeDataflareHost
//   src/dataflare/guest.ts          dataflare-guest   GenOfficeDataflareGuest
//   src/file/management.ts          file-management   (no UMD — Node-friendly)
//
// `minify` + `legalComments:none` trim ~40% off the UMD bundle and strip
// the BSD-type shims in esbuild's preamble. `sourcemap: external` keeps the
// .js.map files alongside the bundles without bloating the npm tarball.
//
// esbuild does not emit `.d.ts` files, so we run `tsc --emitDeclarationOnly`
// afterwards to produce the type bundles the `exports.types` fields point at.
// The d.ts files map 1:1 to the entry points; the existing `dist/editor.d.ts`,
// `dist/embed-url.d.ts`, etc. (from the original single-entry layout) are kept
// as-is because they're still imported by `dist/index.d.ts`.

import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const shared = {
  bundle: true,
  sourcemap: 'external',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  treeShaking: true,
  logLevel: 'info',
}

const targets = [
  { entry: 'src/index.ts',             out: 'index',             umd: 'GenOffice' },
  { entry: 'src/dataflare/host.ts',    out: 'dataflare-host',    umd: 'GenOfficeDataflareHost' },
  { entry: 'src/dataflare/guest.ts',   out: 'dataflare-guest',   umd: 'GenOfficeDataflareGuest' },
  { entry: 'src/dataflare/integration.ts', out: 'dataflare-integration', umd: undefined },
  { entry: 'src/file/management.ts',   out: 'file-management',   umd: undefined },
  { entry: 'src/file/versions.ts',     out: 'file-versions',     umd: undefined },
  { entry: 'src/file/comments.ts',     out: 'file-comments',     umd: undefined },
  { entry: 'src/file/callback.ts',     out: 'file-callback',     umd: undefined },
  { entry: 'src/file/jwt.ts',          out: 'file-jwt',          umd: undefined },
  { entry: 'src/file/embed.ts',        out: 'file-embed',        umd: undefined },
  { entry: 'src/embed/nonce.ts',       out: 'embed-nonce',       umd: undefined },
  { entry: 'src/ai/translation.ts',   out: 'ai-translation',    umd: undefined },
  { entry: 'src/ai/agent.ts',         out: 'ai-agent',          umd: undefined },
  { entry: 'src/auth/mint.ts',        out: 'auth-mint',         umd: undefined },
  { entry: 'src/auth/client.ts',      out: 'auth-client',       umd: undefined },
  { entry: 'src/collab/cursor.ts',    out: 'collab-cursor',     umd: undefined },
  { entry: 'src/collab/presence.ts',  out: 'collab-presence',   umd: undefined },
  { entry: 'src/collab/lock.ts',      out: 'collab-lock',       umd: undefined },
  { entry: 'src/collab/comments.ts',  out: 'collab-comments',   umd: undefined },
]

// Entry manifest — the single source of truth for which bundles this build
// produced. The web-server's `/static/sdk/*` allow-list and its startup
// self-check both derive from this file rather than re-listing filenames by
// hand; a hand-copied list silently 404s the moment an entry is added here
// (sdk1.md §11.125). Written next to this script and committed, so a fresh
// clone and a Docker build see the same list without running this script
// first — CI asserts the committed copy is in sync via `--check`.
const manifest = {
  version: 1,
  generatedBy: 'apps/sdk/scripts/build.mjs',
  entries: targets.map((t) => ({ entry: t.entry, out: t.out, umd: Boolean(t.umd) })),
}
const manifestJson = JSON.stringify(manifest, null, 2) + '\n'
const manifestPath = resolve(__dirname, 'sdk-entries.json')

if (process.argv.includes('--check')) {
  const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : ''
  if (current !== manifestJson) {
    console.error('[sdk] sdk-entries.json is stale — run `node scripts/build.mjs` and commit the result')
    process.exit(1)
  }
  console.log(`[sdk] sdk-entries.json in sync (${targets.length} entries)`)
  process.exit(0)
}

for (const t of targets) {
  const entry = resolve(root, t.entry)
  const base = { ...shared, entryPoints: [entry] }
  await build({ ...base, format: 'esm', outfile: resolve(root, `dist/${t.out}.mjs`) })
  await build({ ...base, format: 'cjs', outfile: resolve(root, `dist/${t.out}.cjs`) })
  if (t.umd) {
    await build({ ...base, format: 'iife', globalName: t.umd, outfile: resolve(root, `dist/${t.out}.umd.js`) })
  }
}

// Emit `.d.ts` (and `.d.ts.map`) for every file under `src/`. The tsconfig
// already has `declaration: true` + `outDir: ./dist` + `rootDir: ./src`, so
// a single tsc invocation produces one d.ts per source file mapped to the
// same relative path under `dist/`. The package.json `exports.types`
// fields point at these emitted files.
await runTsc([])

writeFileSync(manifestPath, manifestJson)

console.log(`[sdk] built ${targets.length} entries × ESM + CJS${targets.some((t) => t.umd) ? ' + UMD' : ''} + d.ts →`, resolve(root, 'dist'))
console.log(`[sdk] wrote entry manifest →`, manifestPath)

function runTsc(args) {
  return new Promise((resolveProm, rejectProm) => {
    const child = spawn('npx', ['tsc', '-p', 'tsconfig.json', ...args], { cwd: root, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? resolveProm() : rejectProm(new Error(`tsc exited ${code}`))))
  })
}