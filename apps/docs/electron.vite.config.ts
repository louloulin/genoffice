import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// The zh CJK body font is the single largest first-open asset (2.5MB woff2).
// Discovered only after CSSOM+layout, its fetch used to start well after first
// paint; a build-time preload link starts it during head parse. Sans (not
// serif) is the default-theme chain's CJK terminus, so it is the one font
// worth preloading for every locale — KR-only locales still lazily fetch
// their KR subsets on top.
function cjkFontPreload(): Plugin {
  return {
    name: 'docs-cjk-font-preload',
    transformIndexHtml(html, ctx) {
      // Dev server has no bundle: fonts load lazily via CSS as before.
      const bundle = ctx.bundle
      if (!bundle) return html
      const cjk = Object.keys(bundle).find(
        (name) => name.endsWith('.woff2') && name.includes('NotoSansCJKsc-Regular-subset'),
      )
      if (!cjk) return html
      const href = `./${cjk.replace(/^\.?\//, '')}`
      const tag = `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`
      return html.replace('</head>', `${tag}</head>`)
    },
  }
}

// Resolve workspace packages from this checkout's sources: in a git worktree
// node_modules is a symlink into the main checkout, so bare specifiers would
// silently bundle the other checkout's (possibly stale) code.
const localAlias = {
  // fonts.css references `@genoffice/ui/fonts/*` (Carlito woff2 twins). In a
  // git worktree node_modules symlinks to the main checkout, so this prefix
  // must resolve to THIS checkout's font files or the new woff2s won't be
  // found and the url() stays unresolved in the emitted CSS.
  '@genoffice/ui/fonts': resolve(__dirname, '../../packages/ui/src/fonts'),
  '@genoffice/docx-engine': resolve(__dirname, '../../packages/docx-engine/src/index.ts'),
  // subpath before the bare name: string aliases are prefix replacements
  '@genoffice/ipc-bridge/client': resolve(__dirname, '../../packages/ipc-bridge/src/client.ts'),
  '@genoffice/ipc-bridge/web-native': resolve(__dirname, '../../packages/ipc-bridge/src/web-native.ts'),
  '@genoffice/ipc-bridge/web-tabs': resolve(__dirname, '../../packages/ipc-bridge/src/web-tabs.ts'),
  '@genoffice/ipc-bridge/sdk-command-sink': resolve(__dirname, '../../packages/ipc-bridge/src/sdk-command-sink.ts'),
  '@genoffice/ipc-bridge/text-buffer-adapter': resolve(__dirname, '../../packages/ipc-bridge/src/text-buffer-adapter.ts'),
  '@genoffice/ipc-bridge/sidebar-runtime': resolve(__dirname, '../../packages/ipc-bridge/src/sidebar-runtime.ts'),
  '@genoffice/ipc-bridge': resolve(__dirname, '../../packages/ipc-bridge/src/index.ts'),
  // Pin the embed guest's SDK entry: the renderer uses two subpaths, and a
  // worktree's node_modules symlinks to the main checkout, so leaving them
  // bare would bundle that checkout's stale dist — the staged progress events
  // (A22/A56) would then be missing from the guest this build produces.
  '@genoffice/web-sdk/dataflare/guest': resolve(__dirname, '../sdk/src/dataflare/guest.ts'),
  '@genoffice/web-sdk/dataflare/integration': resolve(
    __dirname,
    '../sdk/src/dataflare/integration.ts',
  ),
}

// Web dual-protocol: the browser talks to the Electron main process over
// HTTP/SSE served by @genoffice/ipc-bridge on this loopback port (renderer dev
// port +100, env-overridable).
const ipcBridgeProxy = {
  '/api': {
    target: `http://127.0.0.1:${Number(process.env.DOCS_IPC_PORT) || 5273}`,
    changeOrigin: true,
  },
}

export default defineConfig({
  // Main and preload use only electron + node builtins; bundle everything so
  // the packaged app doesn't rely on node_modules at runtime.
  // @genoffice/* deps ship as raw TS source with extensionless imports, so they
  // must be bundled — externalizing them yields ERR_MODULE_NOT_FOUND under Node
  // (same setup as apps/slides).
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@genoffice/electron-utils', '@genoffice/font-metrics', '@genoffice/ipc-bridge'],
      }),
    ],
    resolve: { alias: localAlias },
  },
  preload: {
    // Sandboxed preload scripts cannot require arbitrary npm packages at
    // runtime, so the drop-open bridge must be bundled, not externalized.
    plugins: [
      externalizeDepsPlugin({ exclude: ['@genoffice/electron-utils', '@genoffice/ipc-bridge'] }),
    ],
    resolve: { alias: localAlias },
  },
  renderer: {
    plugins: [react(), cjkFontPreload()],
    resolve: { alias: localAlias },
    server: {
      // Overridable so multiple genoffice dev instances can coexist (default 5173).
      port: Number(process.env.DOCS_DEV_PORT) || 5173,
      strictPort: Boolean(process.env.DOCS_DEV_PORT),
      proxy: ipcBridgeProxy,
    },
  },
})
