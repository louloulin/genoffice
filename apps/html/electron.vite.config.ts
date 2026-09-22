import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Resolve workspace packages from this checkout's sources: in a git worktree
// node_modules is a symlink into the main checkout, so bare specifiers would
// silently bundle the other checkout's (possibly stale) code.
//
// Subpaths must come before the bare name: string aliases are prefix
// replacements, so `'@genoffice/ipc-bridge'` listed first would rewrite
// `'@genoffice/ipc-bridge/sidebar-runtime'` into
// `.../ipc-bridge/src/index.ts/sidebar-runtime` and the renderer build fails
// with ENOTDIR. apps/{docs,sheets,slides,pdf,markdown} already order it this
// way; html previously had no alias block at all and silently bundled the
// pre-sidebar ipc-bridge from node_modules.
const localAlias = {
  '@genoffice/ipc-bridge/client': resolve(__dirname, '../../packages/ipc-bridge/src/client.ts'),
  '@genoffice/ipc-bridge/web-native': resolve(__dirname, '../../packages/ipc-bridge/src/web-native.ts'),
  '@genoffice/ipc-bridge/web-tabs': resolve(__dirname, '../../packages/ipc-bridge/src/web-tabs.ts'),
  '@genoffice/ipc-bridge/sdk-command-sink': resolve(__dirname, '../../packages/ipc-bridge/src/sdk-command-sink.ts'),
  '@genoffice/ipc-bridge/text-buffer-adapter': resolve(__dirname, '../../packages/ipc-bridge/src/text-buffer-adapter.ts'),
  '@genoffice/ipc-bridge/sidebar-runtime': resolve(__dirname, '../../packages/ipc-bridge/src/sidebar-runtime.ts'),
  '@genoffice/ipc-bridge': resolve(__dirname, '../../packages/ipc-bridge/src/index.ts'),
}

export default defineConfig({
  // @genoffice/i18n and @genoffice/electron-utils ship as TS source — must be bundled
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@genoffice/i18n', '@genoffice/electron-utils', '@genoffice/ipc-bridge'],
      }),
    ],
    resolve: { alias: localAlias },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@genoffice/i18n', '@genoffice/electron-utils', '@genoffice/ipc-bridge'],
      }),
    ],
    resolve: { alias: localAlias },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: localAlias },
    server: {
      port: Number(process.env.HTML_DEV_PORT) || 5178,
      strictPort: Boolean(process.env.HTML_DEV_PORT),
    },
  },
})
