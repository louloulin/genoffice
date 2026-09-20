/**
 * Shared lifecycle helpers for the suites that boot the real bundle.
 *
 * Every e2e suite here spawns `dist/bundle/index.js` against a temp
 * `DATA_DIR` and then deletes that directory. Once the server gained a
 * SIGTERM handler that flushes its debounced state (recents, file index), the
 * delete started racing with those writes and failing with `ENOTEMPTY` — the
 * process was still alive when `rmSync` walked the tree.
 *
 * Waiting for the exit event before sweeping fixes the race at its source; the
 * retry budget covers the residual async fs work a killed process may leave.
 */
import { rmSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'

/** SIGTERM the server, wait for it to actually exit, then remove `dataDir`. */
export async function stopServer(
  server: ChildProcess | undefined,
  dataDir?: string,
): Promise<void> {
  if (server && server.exitCode === null && !server.killed) {
    await new Promise<void>((resolve) => {
      server.once('exit', () => resolve())
      server.kill('SIGTERM')
      /* A server that ignores SIGTERM must not hang the suite forever. */
      setTimeout(() => {
        server.kill('SIGKILL')
        resolve()
      }, 5_000).unref?.()
    })
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
