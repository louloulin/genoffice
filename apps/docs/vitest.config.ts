import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits (same convention as packages/pdf2docx)
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@genoffice/font-metrics': local('../../packages/font-metrics/src/index.ts'),
      '@genoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@genoffice/ai-provider': local('../../packages/ai-provider/src/index.ts'),
      '@genoffice/i18n': local('../../packages/i18n/src/index.ts'),
      '@genoffice/ui': local('../../packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
    // This suite is the heaviest in the repo (jsdom + the docx engine per file).
    // Parallel workers exhaust memory on small runners and containers, which
    // surfaces as "Worker exited unexpectedly" on random files instead of a real
    // assertion failure. Vitest 4 replaced poolOptions.forks.singleFork with
    // fileParallelism: one worker, files run in sequence, deterministic run.
    fileParallelism: false,
  },
})
