import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@genoffice/i18n': resolve(__dirname, '../../packages/i18n/src'),
      '@genoffice/ipc-bridge/client': resolve(__dirname, '../../packages/ipc-bridge/src/client.ts'),
      '@genoffice/ipc-bridge/web-native': resolve(
        __dirname,
        '../../packages/ipc-bridge/src/web-native.ts',
      ),
      '@genoffice/ipc-bridge': resolve(__dirname, '../../packages/ipc-bridge/src/index.ts'),
    },
  },
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    outDir: resolve(__dirname, 'out/renderer'),
    emptyOutDir: true,
  },
})
