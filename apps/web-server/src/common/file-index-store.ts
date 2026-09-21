/**
 * Persistence for `FILES_INDEX`, the id → FileInfo map that `files:read({id})`
 * resolves against.
 *
 * The map used to be process-local, so every upload id became worthless the
 * moment the server restarted: the file was still on disk, but nothing could
 * map its id back to a path and the renderer's saved reference dangled. This
 * store writes the map to `${DATA_DIR}/files-index.json` so ids survive.
 *
 * The map itself stays in `state.ts` (it is process state, and other modules
 * read it directly). This module owns only the persistence around it, which
 * keeps the dependency one-directional: store → state, never the reverse.
 *
 * ## Concurrency
 *
 * Three races are handled here, each of which silently lost data in an earlier
 * iteration:
 *
 *  1. **Id collision.** Ids mix a monotonic counter with `Date.now()` and a
 *     random suffix. `Date.now()` alone repeats for uploads landing in the same
 *     millisecond (a 100-file drop), and two entries then shared an id, so one
 *     overwrote the other in the map.
 *  2. **Stale dirty flag.** A promise-chain with a boolean `dirty` flag ran the
 *     first flush while the map was still loading, then cleared `dirty`, so
 *     later flushes skipped and their entries were dropped. The fix is a
 *     monotonic `gen` captured when a write *starts*, so mutations that land
 *     during the await are not folded into the completed generation.
 *  3. **Read-modify-write interleaving.** `flushNow()` runs inside a mutex, so
 *     a burst of N flushes serialises into at most one disk write: only the
 *     last one observes a bumped `gen`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Mutex, atomicWriteJson } from '@genoffice/file-management'
import { DATA_DIR, FILES_INDEX, type FileInfo } from './state'

/** Where the index is persisted. Sibling of the other `DATA_DIR` state files. */
export const FILES_INDEX_FILE = join(DATA_DIR, 'files-index.json')

export class FileIndexStore {
  private readonly mutex = new Mutex()
  /** Bumped on every mutation; a flush persists up to the generation it saw
   *  when it started. */
  private gen = 0
  /** The generation most recently written to disk. */
  private writtenGen = 0
  /** Monotonic tie-breaker so ids stay unique within one millisecond. */
  private counter = 0
  private loaded = false

  constructor(private readonly file: string = FILES_INDEX_FILE) {}

  /** Populate the shared map from disk. Safe to call repeatedly: the first
   *  call wins, since a later load could only replace newer in-memory entries
   *  with stale disk state. */
  fromDiskSync(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.file, 'utf-8'))
    } catch {
      /* A corrupt index is not fatal: the files are still on disk, and the
       * index rebuilds as they are re-opened. Booting beats throwing. */
      return
    }
    /* Accept both shapes so a file written by an older build (a bare object
     * keyed by id) still rehydrates. */
    const rows: unknown[] = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? Object.values(parsed as Record<string, unknown>)
        : []
    /* Resolve the active backend once at load time: rows whose
     * backendId doesn't match get dropped (with a console warning) so
     * an operator who switched `GENOFFICE_STORAGE` mid-life doesn't
     * silently serve dangling `storage://<other-backend>/...` references
     * that the new backend can't resolve. Rows from older builds that
     * never recorded `backendId` are kept — the path itself tells us
     * which backend, when it's `storage://...`; bare absolute paths
     * are assumed to be the local backend. */
    let activeBackendId = 'local'
    let dropMismatched: ((row: { backendId?: string; path?: string }) => boolean) | null = null
    try {
      const { getStorageBackend } = require('./state') as typeof import('./state')
      activeBackendId = getStorageBackend().id
    } catch {
      /* unit test path — accept everything. */
    }
    dropMismatched = (row): boolean => {
      const path = row.path ?? ''
      const recorded = row.backendId
      if (!recorded) {
        /* legacy row: infer from path shape. */
        if (path.startsWith('storage://')) {
          const declared = path.split('/')[2]
          return declared === activeBackendId
        }
        return true /* absolute paths assumed local — match whatever backend is local */
      }
      return recorded === activeBackendId
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const info = row as Partial<FileInfo>
      if (typeof info.id !== 'string' || typeof info.path !== 'string') continue
      if (!dropMismatched(info)) {
        console.warn(
          `file-index-store: dropping ${info.id} — backend "${info.backendId ?? info.path.split('/')[2] ?? '?'}" != active "${activeBackendId}"`,
        )
        continue
      }
      FILES_INDEX.set(info.id, {
        id: info.id,
        path: info.path,
        name: typeof info.name === 'string' ? info.name : (info.path.split('/').pop() ?? info.id),
        size: typeof info.size === 'number' ? info.size : 0,
        mimeType: typeof info.mimeType === 'string' ? info.mimeType : 'application/octet-stream',
        createdAt: typeof info.createdAt === 'number' ? info.createdAt : Date.now(),
        updatedAt: typeof info.updatedAt === 'number' ? info.updatedAt : Date.now(),
        /* `backendId` is preserved verbatim when present; legacy rows
         * (written before the field existed) come back undefined so the
         * existing `rehydrates every field` test stays accurate. */
        backendId: typeof info.backendId === 'string' ? info.backendId : undefined,
      })
    }
  }

  /** Record an entry and mark the index dirty. The active storage
   *  backend id is captured here (when the import is present) so the
   *  row survives a backend switch only when the bytes really did land
   *  in the new backend. */
  set(info: FileInfo): void {
    try {
      /* Lazy import to avoid a circular dep: state.ts already imports
       * file-index-store at boot, so we resolve the backend on demand
       * rather than passing it through the constructor. */
      const { getStorageBackend } = require('./state') as typeof import('./state')
      if (!info.backendId) info.backendId = getStorageBackend().id
    } catch {
      /* If state.ts failed to load (e.g. a unit test that fakes
       * FILES_INDEX without booting the server), leave the field off. */
    }
    FILES_INDEX.set(info.id, info)
    this.gen += 1
  }

  delete(id: string): boolean {
    const removed = FILES_INDEX.delete(id)
    if (removed) this.gen += 1
    return removed
  }

  /**
   * Bucket-friendly content-addressed key. Same bytes ⇒ same key, so
   * the storage backend naturally dedupes across uploads. The `<name>`
   * argument is only used to derive the file extension; the body hash
   * dominates so renaming a file can't make its storage path unstable.
   *
   * Marked async because the actual hashing lives in
   * `@genoffice/file-management/storage/key` and the import is wired
   * lazily to keep this module free of a hard dep at construction time.
   */
  async nextKey(opts: { bytes: Uint8Array; name: string; mimeType?: string }): Promise<string> {
    const { keyForFile } = await import('@genoffice/file-management/storage/key')
    this.counter += 1
    return keyForFile(opts)
  }

  /** Legacy synchronous id mint kept for callers that don't have the
   *  bytes at id-mint time (currently none — every upload path now
   *  reads the bytes before calling this). */
  nextId(name: string): string {
    this.counter += 1
    return `${this.counter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`
  }

  /**
   * Persist if anything changed since the last write.
   *
   * Runs inside the mutex and captures `gen` *before* awaiting, so a mutation
   * that lands mid-write leaves `gen > writtenGen` and the next flush picks it
   * up instead of being skipped.
   */
  async flushNow(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      /* Capture at the start, not at completion: the point is to notice
       * writes that happened while we were awaiting. */
      const startGen = this.gen
      if (startGen <= this.writtenGen) return
      const snapshot = Array.from(FILES_INDEX.values())
      atomicWriteJson(this.file, snapshot)
      /* Only advance to the generation actually serialised. A mutation during
       * `atomicWriteJson` bumped `gen` past `startGen` and stays pending. */
      this.writtenGen = startGen
    })
  }

  /** Persist now and wait; used by the shutdown path so a SIGTERM does not
   *  discard ids created in the last few seconds. */
  async flushSync(): Promise<void> {
    await this.flushNow()
  }

  /** Test/diagnostic hook: has everything been persisted? */
  get isClean(): boolean {
    return this.gen <= this.writtenGen
  }
}

/**
 * The process-wide instance. Handlers import this rather than constructing
 * their own, so there is exactly one writer for `${DATA_DIR}/files-index.json`.
 */
export const fileIndexStore = new FileIndexStore()

/** Directory the index lives in; exported for tests that seed a fixture. */
export const fileIndexDir = dirname(FILES_INDEX_FILE)
