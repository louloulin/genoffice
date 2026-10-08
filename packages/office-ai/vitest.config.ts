import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // bundle/docx work is slow under jsdom
    testTimeout: 120000,
    // the workspace packages are linked as source (.ts); inline them so vite
    // transforms them instead of handing them to node
    server: { deps: { inline: [/@genoffice\//] } },
  },
})
