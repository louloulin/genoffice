import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Runtime wasm assets live in node_modules during dev/tests. The packaged
 * desktop app ships no node_modules, so electron-builder copies them into
 * Resources/wasm instead (see apps/shell/electron-builder.cjs extraResources).
 * A plain Node process has no `process.resourcesPath`, so that fallback is
 * skipped rather than crashing the standalone Web server.
 */
function packagedPath(fileName: string): string | null {
  const root = (process as { resourcesPath?: string }).resourcesPath
  return root ? join(root, 'wasm', fileName) : null
}

/** Absolute path of the harfbuzz subsetting wasm used by font embedding. */
export function hbSubsetWasmPath(): string {
  const req = createRequire(import.meta.url)
  try {
    // harfbuzzjs <=0.10 ships hb-subset.wasm at the package root with no exports map
    return req.resolve('harfbuzzjs/hb-subset.wasm')
  } catch {
    /* fall through */
  }
  try {
    // harfbuzzjs >=1.x seals subpaths; the wasm sits next to the exported entry point
    const candidate = join(dirname(req.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')
    if (existsSync(candidate)) return candidate
  } catch {
    /* fall through */
  }
  const packaged = packagedPath('hb-subset.wasm')
  if (packaged) return packaged
  throw new Error('hb-subset.wasm not found: install harfbuzzjs or ship it in Resources/wasm')
}
