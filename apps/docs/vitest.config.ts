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
      // subpath before the bare name: string aliases are prefix replacements
      '@genoffice/electron-utils/headless-export': local(
        '../../packages/electron-utils/src/headless-export.ts',
      ),
      '@genoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@genoffice/ai-provider/browser': local('../../packages/ai-provider/src/browser.ts'),
      '@genoffice/ai-provider/codex-app-server': local('../../packages/ai-provider/src/codex-app-server.ts'),
      '@genoffice/ai-provider': local('../../packages/ai-provider/src/index.ts'),
      '@genoffice/i18n': local('../../packages/i18n/src/index.ts'),
      '@genoffice/ui': local('../../packages/ui/src/index.ts'),
      // subpath before the bare name: vite treats a string alias as a prefix
      // replacement, so the bare key last would rewrite
      // `@genoffice/translation-core/document` into `.../index.ts/document`.
      // The renderer imports the subpath because it is the browser-safe entry —
      // the bare entry drags in the provider and its Node built-ins.
      '@genoffice/translation-core/document': local(
        '../../packages/translation-core/src/document.ts',
      ),
      // Same ordering rule for the embed wire-body builder.
      '@genoffice/translation-core/embed-body': local(
        '../../packages/translation-core/src/embed-body.ts',
      ),
      '@genoffice/translation-core/translated-file-name': local(
        '../../packages/translation-core/src/translated-file-name.ts',
      ),
      '@genoffice/translation-core': local('../../packages/translation-core/src/index.ts'),
      // SDK sub-paths are declared before the bare name: vite treats a string
      // alias as a prefix replacement, so the general key last would swallow
      // every `@genoffice/web-sdk/...` import.
      '@genoffice/web-sdk/dataflare/guest': local('../../apps/sdk/src/dataflare/guest.ts'),
      '@genoffice/web-sdk/dataflare/integration': local(
        '../../apps/sdk/src/dataflare/integration.ts',
      ),
      '@genoffice/web-sdk': local('../../apps/sdk/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
  },
})
