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
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'

/**
 * Ask the OS for a free loopback port and hand it back for the caller to bind.
 *
 * Suites used to pick `BASE + Math.floor(Math.random() * N)` with hand-picked
 * ranges. Under `vitest run` the whole file list executes in parallel, so
 * several ranges overlapped (18089–19500 was claimed by a dozen suites at
 * once) and a spawned server would occasionally bind a neighbour's port — the
 * failure surfaced as a *foreign* server answering our probes (404s, a
 * different `/health` posture) and read like a real regression. Letting the OS
 * allocate from the ephemeral pool removes the range arithmetic that caused it.
 */
export async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port > 0 ? resolve(port) : reject(new Error('no port assigned'))))
    })
  })
}

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
