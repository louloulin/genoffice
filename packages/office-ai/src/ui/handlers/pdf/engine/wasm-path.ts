/**
 * Copied from `apps/pdf/src/main/wasm-path.ts` with one structural fix: the
 * module-URL derivation. office-ai is built by `packages/office-ai/build.mjs`
 * with esbuild `format:'cjs'`, `bundle:true` — `import.meta.url` is not a
 * dependable way to seed `createRequire` there, and under plain Node (no
 * Electron) `process.resourcesPath` does not exist at all, so the packaged-app
 * fallback must be guarded rather than fed `undefined` to `path.join`.
 *
 * Resolution order is unchanged otherwise: the wasm ships inside the
 * dependency package, so a resolvable specifier always wins; the packaged
 * Resources/wasm copy is only a fallback for a bundle that inlined node_modules.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `__filename` exists in the CJS bundle; `import.meta.url` exists when this
 * source runs as ESM (vitest). Same shape as `src/ui/assets.ts`, so the two
 * agree on which directory "this module" is.
 */
function moduleBase(): string {
  return typeof __filename === 'string' ? __filename : fileURLToPath(import.meta.url)
}

const req = () => createRequire(moduleBase())

/** Electron-only; under plain Node `process.resourcesPath` is undefined. */
function packagedPath(fileName: string): string {
  const resources = (process as { resourcesPath?: string }).resourcesPath
  return join(typeof resources === 'string' && resources ? resources : '', 'wasm', fileName)
}

export function pdfiumWasmPath(): string {
  try {
    return req().resolve('@embedpdf/pdfium/pdfium.wasm')
  } catch {
    return packagedPath('pdfium.wasm')
  }
}

export function hbSubsetWasmPath(): string {
  const r = req()
  try {
    // harfbuzzjs ≤0.10 ships hb-subset.wasm at the package root with no exports map
    return r.resolve('harfbuzzjs/hb-subset.wasm')
  } catch {
    /* fall through */
  }
  try {
    // harfbuzzjs ≥1.x seals subpaths; the wasm sits next to the exported entry point
    const p = join(dirname(r.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')
    if (existsSync(p)) return p
  } catch {
    /* fall through */
  }
  return packagedPath('hb-subset.wasm')
}