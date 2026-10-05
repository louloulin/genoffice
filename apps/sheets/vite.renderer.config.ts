import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// renderer-only dev server (embedded by the shell via SHEETS_RENDERER_URL for HMR; no standalone Electron)
export default defineConfig({
  root: 'src/renderer',
  plugins: [react()],
  // Worktree-safe: node_modules/@genoffice/ui symlinks to the main checkout, so
  // the woff2 font twins committed here are invisible without this prefix.
  resolve: { alias: { '@genoffice/ui/fonts': resolve(__dirname, '../../packages/ui/src/fonts') } },
  server: {
    // web version: same-origin proxy to the HTTP IPC bridge inside the running
    // Electron main process (keeps the page CSP's connect-src 'self' intact)
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(process.env.SHEETS_IPC_PORT) || 5274}`,
        changeOrigin: true,
      },
    },
        port: Number(process.env.SHEETS_DEV_PORT) || 5174,
    strictPort: true,
  },
})
