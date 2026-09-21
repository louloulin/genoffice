import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src/index.ts')
const shared = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  target: ['es2022'],
  platform: 'node',
  external: ['@genoffice/ai-provider'],
  logLevel: 'info',
}
await build({ ...shared, format: 'esm', outfile: resolve(root, 'dist/index.mjs') })
await build({ ...shared, format: 'cjs', outfile: resolve(root, 'dist/index.cjs') })
console.log('[provider-gemini] built')
