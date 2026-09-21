import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: 'dot',
  },
  // Force vitest to load the SDK source files directly rather than the
  // dist build (which is what package.json `exports` points at). Tests
  // exercise the latest edits without needing a rebuild step.
  resolve: {
    alias: {
      '@genoffice/web-sdk': new URL('./src/index.ts', import.meta.url).pathname,
    },
  },
})
