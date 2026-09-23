// Multi-instance xlsx-sidecar pool (sdk1 §11.87 P1-3).
//
// The single-process `WebSheetsSidecar` (sidecar.ts) serialises every
// request on one stdin pipe and one mpsc::sync_channel<8> — see
// `apps/sheets/native/xlsx-engine/src/main.rs:333` which loops over
// `requests` on the main thread. End-to-end benchmarking (see
// `/tmp/genoffice-perf-report.md` §2.3) confirmed:
//
//   - 50 concurrent saves wall-clock = 50 × serial save wall-clock
//   - At 200 ms sidecar latency: throughput ceiling = 5 saves/s
//
// This pool runs N independent `xlsx-sidecar` child processes and
// hashes each request by a stable key (path / sessionId) so the same
// file/session always reaches the same worker. The Rust sessions map
// is per-process, so this routing is essential — otherwise a session
// created on worker A would 404 on worker B.
//
// All public methods mirror the `WebSheetsSidecar` surface so
// `saveWorkbookViaSidecar({client, ...})` accepts a pool instance
// without any xlsx-gateway changes.

import { WebSheetsSidecar } from './sidecar'

/** Default worker count. Tunable via `SHEETS_SIDECAR_POOL_SIZE` env var. */
const DEFAULT_POOL_SIZE = 4
/** Hard cap — spawning more workers than there are cores helps no one. */
const MAX_POOL_SIZE = 16

function envPoolSize(): number {
  const raw = process.env.SHEETS_SIDECAR_POOL_SIZE
  if (!raw) return DEFAULT_POOL_SIZE
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1) return DEFAULT_POOL_SIZE
  return Math.min(Math.floor(n), MAX_POOL_SIZE)
}

/** FNV-1a 32-bit hash on a string. Cheap, deterministic, no deps. */
function hashKey(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h
}

/**
 * Pool of `WebSheetsSidecar` workers, each backed by its own child
 * process. Routing:
 *
 *   - `open(path)`                  → worker[hash(path)            % N]
 *   - `archiveManifest(path)`       → worker[hash(path)            % N]
 *   - `saveArchive({sourcePath,..})`→ worker[hash(sourcePath)     % N]
 *   - `readRange({sessionId,..})`   → worker[hash(sessionId)      % N]
 *
 * Same key → same worker, so a session opened on worker A is
 * readable on worker A only. This is what makes the pool a drop-in
 * replacement for the single sidecar (the Rust sessions map is
 * per-process and non-replicated across the pool).
 */
export class WebSheetsSidecarPool {
  readonly size: number
  private readonly workers: WebSheetsSidecar[]
  /** Round-robin counter for the (rare) no-key case. */
  private next = 0

  constructor(
    size: number = envPoolSize(),
    binaryPath?: string,
  ) {
    const clamped = Math.min(Math.max(1, Math.floor(size)), MAX_POOL_SIZE)
    this.size = clamped
    this.workers = Array.from(
      { length: clamped },
      () => new WebSheetsSidecar(binaryPath),
    )
  }

  /** Pick worker for a sessionId-bound call (readRange). */
  pickBySessionId(sessionId: string): WebSheetsSidecar {
    return this.workers[hashKey(sessionId) % this.size]
  }

  /** Pick worker for a path-bound call (open / archiveManifest / saveArchive). */
  pickByPath(path: string): WebSheetsSidecar {
    return this.workers[hashKey(path) % this.size]
  }

  /** Round-robin fallback for the (unreachable) no-key case. */
  private pickRoundRobin(): WebSheetsSidecar {
    const w = this.workers[this.next % this.size]!
    this.next = (this.next + 1) % this.size
    return w
  }

  /** Open a workbook. The sessionId the sidecar returns is owned by
   *  the picked worker; subsequent calls on that session must route
   *  back here via `pickBySessionId`. */
  async open(path: string, locale?: string): Promise<unknown> {
    return this.pickByPath(path).open(path, locale)
  }

  async readRange(input: {
    readonly sessionId: string
    readonly sheetId: string
    readonly range: { startRow: number; endRow: number; startColumn: number; endColumn: number }
    /** Optional source path. When supplied (the typical case after
     *  `workbook:open-path` registers the session in the workbook
     *  registry), the pool routes by path so the request lands on
     *  the same worker that handled `open(path)` — the per-process
     *  Rust sessions map is non-replicated across the pool. Falls
     *  back to the sessionId hash for callers that don't have the
     *  path handy (legacy / cache-warm path). */
    readonly path?: string
  }): Promise<unknown> {
    const worker = input.path
      ? this.pickByPath(input.path)
      : this.pickBySessionId(input.sessionId)
    return worker.readRange(input)
  }

  async archiveManifest(path: string): Promise<unknown> {
    return this.pickByPath(path).archiveManifest(path)
  }

  async saveArchive(input: {
    readonly sourcePath: string
    readonly targetPath: string
    readonly replacements: readonly { name: string; contentPath: string }[]
    readonly removals: readonly string[]
    readonly additions: readonly { name: string; contentPath: string }[]
  }): Promise<unknown> {
    return this.pickByPath(input.sourcePath).saveArchive(input)
  }

  async readEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly outputDir: string
  }): Promise<unknown> {
    return this.pickByPath(input.path).readEntries(input)
  }

  async scanEntries(input: {
    readonly path: string
    readonly entries: readonly string[]
    readonly needle: string
  }): Promise<unknown> {
    return this.pickByPath(input.path).scanEntries(input)
  }

  /** Test / shutdown hook — kill all worker processes. */
  stopAll(): void {
    for (const w of this.workers) {
      try {
        w.stop()
      } catch {
        /* a worker that never spawned (binary missing) throws on stop */
      }
    }
  }

  /** Test-only inspection. */
  describe(): { size: number; indices: number[] } {
    return { size: this.size, indices: this.workers.map((_, i) => i) }
  }
}

/**
 * Module-level singleton — created lazily so the sidecar binary path
 * (resolved from `import.meta.url`) is settled by the time we spawn.
 *
 * Tests can call `_resetSidecarPoolForTests()` to drop the singleton
 * and force the next `getSidecarPool()` call to re-instantiate.
 */
let _pool: WebSheetsSidecarPool | null = null

export function getSidecarPool(): WebSheetsSidecarPool {
  if (!_pool) _pool = new WebSheetsSidecarPool()
  return _pool
}

export function _resetSidecarPoolForTests(): void {
  if (_pool) {
    _pool.stopAll()
    _pool = null
  }
}
