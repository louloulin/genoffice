// Bundle the web-server with esbuild.
//
// This script exists because esbuild's CLI struggles with the `--banner:js=`
// quoting when invoked from a `package.json` script on macOS zsh, and
// because we need a small, repeatable process for the standalone web build.
//
// The banner re-creates `require` via `node:module`'s `createRequire` so
// CommonJS dependencies (most notably `word-extractor`, used by
// `@genoffice/file-parse/src/doc.ts` for legacy .doc files, which does
// `const { Buffer } = require('buffer')`) keep working inside an ESM bundle.

import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outdir = resolve(root, 'dist/bundle')

mkdirSync(outdir, { recursive: true })

// Mark the output directory as ESM. The bundle uses `import`/`export`, and its
// consumers copy `dist/bundle/` into an image where no parent package.json
// exists (the Docker runtime stage), so the marker has to travel with it.
// Relying on Node's syntax detection instead would work today but silently
// ties the image to a Node >= 22.7 runtime.
writeFileSync(resolve(outdir, 'package.json'), JSON.stringify({ type: 'module' }, null, 2) + '\n')

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  // `ws` is imported eagerly by the OpenAI SDK's Node shim (`import * as NodeWs
  // from "ws"`), so it has to be resolvable the moment the bundle loads — even
  // for deployments that never open a WebSocket. The Docker runtime stage
  // copies `dist/bundle/` and no node_modules, so leaving it external meant the
  // image died at startup with ERR_MODULE_NOT_FOUND. Bundle it instead; its two
  // optional native accelerators stay external and are required inside a
  // try/catch, so their absence falls back to ws's JS implementation.
  external: ['node:*', 'bufferutil', 'utf-8-validate'],
  // The op-docs surface (used by the AI provider prompt builder) inlines
  // markdown via Vite-style `?raw` imports. esbuild has no built-in
  // loader for the suffix; strip it and return the file contents as a
  // string so the web-server bundle resolves without a runtime fs read.
  plugins: [
    {
      name: 'md-raw-loader',
      setup(b) {
        b.onResolve({ filter: /\.md\?raw$/ }, (args) => {
          const rel = args.path.replace('?raw', '')
          const path = isAbsolute(rel) ? rel : resolve(args.resolveDir, rel)
          return { path, namespace: 'md-raw' }
        })
        b.onLoad({ filter: /.*/, namespace: 'md-raw' }, (args) => {
          const contents = readFileSync(args.path, 'utf8')
          return { contents: 'export default ' + JSON.stringify(contents), loader: 'js' }
        })
      },
    },
  ],
  banner: {
    js: [
      "import { createRequire as __genofficeCreateRequire } from 'node:module';",
      'const require = __genofficeCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})

// Copy `pdfium.wasm` next to the bundle.
//
// `anydoc:convert` (pdf -> docx) loads the wasm at runtime. The Docker
// runtime stage copies ONLY `dist/bundle/` — no node_modules — so without
// this copy the production image would answer WEB_UNSUPPORTED for a
// conversion it can actually perform. Doing it here (rather than in the
// Dockerfile) keeps `node dist/bundle/index.js` from the repo working too.
// pdf2docx never touches the wasm itself; it receives the initialized
// module, so this is the only wasm asset the server needs.
{
  const require = createRequire(join(root, 'package.json'))
  const wasmSrc = require.resolve('@embedpdf/pdfium/pdfium.wasm')
  if (!existsSync(wasmSrc)) {
    throw new Error(`pdfium.wasm not found at ${wasmSrc}; anydoc pdf->docx would fail at runtime`)
  }
  copyFileSync(wasmSrc, resolve(outdir, 'pdfium.wasm'))
  console.log(`[bundle] copied pdfium.wasm (${readFileSync(wasmSrc).byteLength} bytes) -> dist/bundle/`)
}

// Build the host SDK and stage it at `dist/static/sdk/`.
//
// `/static/sdk/*` is the distribution channel for the host SDK, and the embed
// bridge's consumers load `dataflare-host.umd.js` from it. Those bytes used to
// appear only if someone had already run `pnpm --filter @genoffice/web-sdk
// build` — a hidden prerequisite that neither Dockerfile satisfied, so every
// released image answered 404 for the SDK, and the container's own path
// derivation pointed somewhere else even when the files were present
// (sdk1.md §11.125). Running the SDK pipeline here makes `bundle` alone
// produce a complete `dist/static/sdk/`; a missing script or a non-zero exit
// fails the build rather than shipping a silently empty route.
{
  const sdkRoot = resolve(root, '..', 'sdk')
  for (const script of ['build.mjs', 'copy-sdk-to-webserver.mjs']) {
    const path = join(sdkRoot, 'scripts', script)
    if (!existsSync(path)) {
      throw new Error(
        `SDK build script missing at ${path}; the web-server cannot ship /static/sdk/* without it`,
      )
    }
    const res = spawnSync(process.execPath, [path], { stdio: 'inherit', cwd: sdkRoot })
    if (res.status !== 0) {
      throw new Error(`${script} exited ${res.status}; /static/sdk/* would be empty or stale`)
    }
  }
}
