import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// node_modules/@genoffice/ui symlinks to the main checkout, so the woff2 font
// twins committed here (and the `?url` imports that pull them) are invisible
// without a path alias — same convention as the electron-vite/vite configs.
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/ui/fonts': local('../../packages/ui/src/fonts'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
