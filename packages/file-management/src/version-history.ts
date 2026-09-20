/**
 * Bounded per-document version history.
 *
 * Saving over a document destroys the previous revision, and the only reason
 * that is acceptable is that the user can usually undo. "Usually" ends at the
 * next session: once the process exits, an in-memory undo stack is gone. This
 * keeps the last N revisions on disk so a save that turned out to be a mistake
 * is recoverable after a restart.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { atomicWriteFile, atomicWriteJson } from './atomic'

export interface VersionEntry {
  id: string
  /** The document this revision belongs to. */
  path: string
  savedAt: number
  sizeBytes: number
  /** Payload basename inside the versions directory. */
  storedName: string
  /** Optional human note ("autosave", "manual"). */
  label?: string
}

export class VersionHistory {
  private readonly dir: string
  private readonly indexPath: string

  constructor(
    root: string,
    private readonly maxVersions = 20,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dir = join(root, 'versions')
    this.indexPath = join(this.dir, 'index.json')
  }

  private readIndex(): VersionEntry[] {
    try {
      if (!existsSync(this.indexPath)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf-8'))
      return Array.isArray(parsed) ? (parsed as VersionEntry[]) : []
    } catch {
      return []
    }
  }

  private write(entries: VersionEntry[]): void {
    mkdirSync(this.dir, { recursive: true })
    atomicWriteJson(this.indexPath, entries)
  }

  /** Snapshot `path` as a new revision, pruning the oldest beyond the cap. */
  snapshot(path: string, label?: string): VersionEntry | null {
    if (!existsSync(path)) return null
    let bytes: Buffer
    try {
      bytes = readFileSync(path)
    } catch {
      return null
    }
    if (bytes.byteLength === 0) return null
    mkdirSync(this.dir, { recursive: true })
    const id = `${this.now()}-${Math.random().toString(36).slice(2, 8)}`
    const storedName = `${id}-${basename(path)}`
    atomicWriteFile(join(this.dir, storedName), bytes)
    const entry: VersionEntry = {
      id,
      path,
      savedAt: this.now(),
      sizeBytes: bytes.byteLength,
      storedName,
      ...(label ? { label } : {}),
    }
    const all = [...this.readIndex(), entry]
    /* Prune per document, not globally: a heavily-edited file must not evict
     * the single revision of every other document. */
    const forPath = all.filter((e) => e.path === path)
    const keep = new Set(
      forPath
        .sort((a, b) => b.savedAt - a.savedAt)
        .slice(0, this.maxVersions)
        .map((e) => e.id),
    )
    for (const stale of forPath) {
      if (!keep.has(stale.id)) {
        rmSync(join(this.dir, stale.storedName), { force: true })
      }
    }
    this.write(all.filter((e) => e.path !== path || keep.has(e.id)))
    return entry
  }

  /** Revisions for one document, newest first. */
  list(path: string): VersionEntry[] {
    return this.readIndex()
      .filter((e) => e.path === path)
      .sort((a, b) => b.savedAt - a.savedAt)
  }

  /** The revision payload bytes, or null when it is no longer on disk. */
  read(id: string): Buffer | null {
    const entry = this.readIndex().find((e) => e.id === id)
    if (!entry) return null
    const payload = join(this.dir, entry.storedName)
    if (!existsSync(payload)) return null
    try {
      return readFileSync(payload)
    } catch {
      return null
    }
  }

  /** Restore revision `id` over its document, snapshotting the current bytes
   *  first so the restore itself is undoable. */
  restore(id: string): { ok: true; path: string } | { ok: false; error: string } {
    const entry = this.readIndex().find((e) => e.id === id)
    if (!entry) return { ok: false, error: 'version not found' }
    const payload = join(this.dir, entry.storedName)
    if (!existsSync(payload)) return { ok: false, error: 'version payload is missing' }
    if (existsSync(entry.path)) {
      try {
        this.snapshot(entry.path, 'pre-restore')
      } catch {
        /* A failed safety snapshot must not block the restore the user asked
         * for; the current bytes are still on disk until the write below. */
      }
    }
    try {
      atomicWriteFile(entry.path, readFileSync(payload))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'restore failed' }
    }
    return { ok: true, path: entry.path }
  }

  /** Total bytes held by stored revisions, for a storage-usage display. */
  usageBytes(): number {
    if (!existsSync(this.dir)) return 0
    let total = 0
    for (const name of readdirSync(this.dir)) {
      if (name === 'index.json') continue
      try {
        total += statSync(join(this.dir, name)).size
      } catch {
        /* a file removed between readdir and stat: nothing to count */
      }
    }
    return total
  }
}
