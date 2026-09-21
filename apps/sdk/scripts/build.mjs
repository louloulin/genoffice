// esbuild three-target build for the SDK: ESM + CJS + UMD.
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const entry = resolve(root, 'src/index.ts')

const shared = {
  entryPoints: [entry],
  bundle: true,
  sourcemap: true,
  target: ['es2022'],
  logLevel: 'info',
}

await build({ ...shared, format: 'esm', outfile: resolve(root, 'dist/index.mjs') })
await build({ ...shared, format: 'cjs', outfile: resolve(root, 'dist/index.cjs') })
await build({ ...shared, format: 'iife', globalName: 'GenOffice', outfile: resolve(root, 'dist/index.umd.js') })

console.log('[sdk] built ESM + CJS + UMD →', resolve(root, 'dist'))
