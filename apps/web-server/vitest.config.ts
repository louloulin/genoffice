import { defineConfig } from 'vitest/config'

/**
 * Vitest config for the web-server package.
 *
 * Tests live under tests/ and exercise the IPC handlers (skills,
 * marketplace, AI) directly. The marketplace-e2e suite boots the full
 * bundle on a random port and drives it end-to-end to prove that the
 * install → pi-loader → uninstall chain still works after every change.
 *
 * `globalSetup` rebuilds `dist/bundle` when `src/` is newer, because those
 * suites spawn the bundle rather than importing the sources.
 */
export default defineConfig({
  test: {
    globalSetup: ['tests/global-setup.ts'],
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Mirror the bundle's --external list so server modules resolve cleanly.
    server: {
      deps: {
        external: ['ws'],
      },
    },
  },
})
