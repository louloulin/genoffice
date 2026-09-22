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
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const outdir = resolve(root, 'dist/bundle')

mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [resolve(root, 'src/index.ts')],
  outfile: resolve(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  external: ['node:*', 'ws'],
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
