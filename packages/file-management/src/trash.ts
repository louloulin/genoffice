/**
 * Local soft-delete, so `home:delete-files` is recoverable.
 *
 * The home grid's delete used to `unlink` outright: a mis-click destroyed the
 * file with no way back. Deleting now moves the file into `<root>/.trash/`
 * with a sidecar describing where it came from, and the entry can be restored
 * to its original path as long as nothing has taken that name in the meantime.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteJson } from './atomic'

export interface TrashEntry {
  id: string
  /** Where the file lived before it was deleted. */
  originalPath: string
  name: string
  deletedAt: number
  sizeBytes: number
}

interface TrashRecord extends TrashEntry {
  /** Basename inside the trash directory; unique even for same-named files. */
  storedName: string
}

/**
 * A trash directory holds the payloads and a JSON index. The index is the
 * source of truth for what can be restored; a payload without an index entry
 * is orphaned and ignored (rather than guessed at) so a corrupted index can
 * never make restore write to an unexpected location.
 */
export class Trash {
  private readonly dir: string
  private readonly indexPath: string

  constructor(
    root: string,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.dir = join(root, '.trash')
    this.indexPath = join(this.dir, 'index.json')
  }

  private readIndex(): TrashRecord[] {
    try {
      if (!existsSync(this.indexPath)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is TrashRecord =>
          !!e &&
          typeof e === 'object' &&
          typeof (e as TrashRecord).id === 'string' &&
          typeof (e as TrashRecord).storedName === 'string' &&
          typeof (e as TrashRecord).originalPath === 'string',
      )
    } catch {
      return []
    }
  }

  private writeIndex(records: TrashRecord[]): void {
    mkdirSync(this.dir, { recursive: true })
    atomicWriteJson(this.indexPath, records)
  }

  /** Move `path` into the trash. Returns the entry, or null when the file is
   *  already gone (deleting a missing file is not an error). */
  delete(path: string): TrashEntry | null {
    if (!existsSync(path)) return null
    const stats = statSync(path)
    if (!stats.isFile()) return null
    mkdirSync(this.dir, { recursive: true })
    /* Prefix with a UUID so two files with the same basename (from different
     * directories) cannot collide inside the trash. */
    const id = randomUUID()
    const name = basename(path)
    const storedName = `${id}-${name}`
    renameSync(path, join(this.dir, storedName))
    const entry: TrashEntry = {
      id,
      originalPath: path,
      name,
      deletedAt: this.now(),
      sizeBytes: stats.size,
    }
    this.writeIndex([...this.readIndex(), { ...entry, storedName }])
    return entry
  }

  /** Everything currently in the trash, newest first. */
  list(): TrashEntry[] {
    return this.readIndex()
      .map(({ storedName: _storedName, ...entry }) => entry)
      .sort((a, b) => b.deletedAt - a.deletedAt)
  }

  /**
   * Put `id` back at its original path.
   *
   * Refuses when the original path is occupied: silently overwriting whatever
   * is there now would destroy a newer file to resurrect an older one.
   */
  restore(id: string): { ok: true; path: string } | { ok: false; error: string } {
    const records = this.readIndex()
    const record = records.find((r) => r.id === id)
    if (!record) return { ok: false, error: 'trash entry not found' }
    const payload = join(this.dir, record.storedName)
    if (!existsSync(payload)) {
      /* The index outlived its payload; drop the stale row so it stops being
       * offered in the UI. */
      this.writeIndex(records.filter((r) => r.id !== id))
      return { ok: false, error: 'trashed file is missing' }
    }
    if (existsSync(record.originalPath)) {
      return { ok: false, error: 'original path is occupied' }
    }
    mkdirSync(join(record.originalPath, '..'), { recursive: true })
    renameSync(payload, record.originalPath)
    this.writeIndex(records.filter((r) => r.id !== id))
    return { ok: true, path: record.originalPath }
  }

  /** Permanently drop an entry and its payload. */
  purge(id: string): boolean {
    const records = this.readIndex()
    const record = records.find((r) => r.id === id)
    if (!record) return false
    rmSync(join(this.dir, record.storedName), { force: true })
    this.writeIndex(records.filter((r) => r.id !== id))
    return true
  }

  /** Convenience for the reverse direction: which of these paths are in the
   *  trash. Used by the recents watcher, which must not re-add a file that was
   *  just deleted. */
  has(originalPath: string): boolean {
    return this.readIndex().some((r) => r.originalPath === originalPath)
  }

  /** Payload basenames sitting in the trash directory, for diagnostics. */
  storedNames(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir).filter((n) => n !== 'index.json')
  }
}
