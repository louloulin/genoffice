/**
 * Restart-safe recent-file list.
 *
 * The home screen's "最近使用" grid is the user's main way back into a
 * document, so it has to survive a server restart. An in-memory Map does not:
 * every reboot empties the grid even though the files are still on disk.
 *
 * Writes are debounced, because a save-heavy session (`docs:save` fires on a
 * timer) would otherwise rewrite this JSON on every keystroke burst. The
 * debounce is owned here rather than by callers so no channel can bypass it
 * and forget to flush.
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from './atomic'

export interface RecentEntry {
  id: string
  path: string
  name: string
  /** Epoch ms of the last open/save. Sort key for the grid. */
  openedAt: number
  /** True when the file was written, not merely opened. */
  modified: boolean
  starred?: boolean
  projectId?: string
  labels?: string[]
}

export interface RecentsOptions {
  /** Debounce window for persisting. Defaults to 250 ms. */
  debounceMs?: number
  /** Injectable clock, so tests do not have to sleep. */
  now?: () => number
}

/**
 * The recent-files store. `add()` is idempotent by path: re-opening a file
 * moves its entry to the top instead of inserting a second row (the home grid
 * keys on path, so a duplicate would render twice).
 */
export class UnifiedRecents {
  private readonly file: string
  private readonly debounceMs: number
  private readonly now: () => number
  private entries: RecentEntry[] = []
  private timer: NodeJS.Timeout | undefined
  private dirty = false

  /**
   * Number of writes started and completed. Exposed so tests can assert a
   * debounced burst collapses into a single flush without inspecting disk
   * mtimes (which have coarse granularity on some filesystems).
   */
  writes = 0

  private readonly maxEntries: number

  constructor(file: string, options: RecentsOptions & { maxEntries?: number } = {}) {
    this.file = file
    this.debounceMs = options.debounceMs ?? 250
    this.now = options.now ?? (() => Date.now())
    this.maxEntries = options.maxEntries ?? 200
    this.entries = this.read()
  }

  /** Load from disk. A corrupt or absent file yields an empty list rather
   *  than throwing, so a bad write can never stop the server from booting. */
  private read(): RecentEntry[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is RecentEntry =>
          !!e && typeof e === 'object' && typeof (e as RecentEntry).path === 'string',
      )
    } catch {
      return []
    }
  }

  /** Current entries, most recent first. */
  list(): RecentEntry[] {
    return [...this.entries]
  }

  /** The entry for `path`, or undefined. */
  get(path: string): RecentEntry | undefined {
    return this.entries.find((e) => e.path === path)
  }

  /**
   * Record that `path` was opened (or modified). Moves an existing entry to
   * the front instead of duplicating it.
   */
  async add(
    path: string,
    opts: {
      name?: string
      modified?: boolean
      starred?: boolean
      projectId?: string
      labels?: string[]
    } = {},
  ): Promise<RecentEntry> {
    const existing = this.get(path)
    const entry: RecentEntry = {
      id: existing?.id ?? path,
      path,
      name: opts.name ?? existing?.name ?? path.split(/[\\/]/).pop() ?? path,
      openedAt: this.now(),
      modified: opts.modified ?? existing?.modified ?? false,
      ...((opts.starred ?? existing?.starred) ? { starred: true } : {}),
      ...((opts.projectId ?? existing?.projectId)
        ? { projectId: opts.projectId ?? existing?.projectId }
        : {}),
      ...((opts.labels ?? existing?.labels) ? { labels: opts.labels ?? existing?.labels } : {}),
    }
    this.entries = [entry, ...this.entries.filter((e) => e.path !== path)].slice(0, this.maxEntries)
    this.schedule()
    return entry
  }

  /** Remove `path` from the list (the file may or may not still exist). */
  async remove(path: string): Promise<boolean> {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.path !== path)
    if (this.entries.length === before) return false
    this.schedule()
    return true
  }

  /** Move `from` to `to`, keeping the entry in place. Used by rename, where
   *  the recents row must follow the file rather than vanish. */
  async rename(from: string, to: string): Promise<boolean> {
    const entry = this.get(from)
    if (!entry) return false
    entry.path = to
    entry.name = to.split(/[\\/]/).pop() ?? to
    entry.openedAt = this.now()
    this.schedule()
    return true
  }

  /** Flip the star flag on `path`, creating an entry if the file is not yet
   *  listed (starring from the file browser). */
  async setStarred(path: string, starred: boolean, name?: string): Promise<RecentEntry> {
    const entry = this.get(path)
    if (entry) {
      if (starred) entry.starred = true
      else delete entry.starred
      this.schedule()
      return entry
    }
    return await this.add(path, { name, starred })
  }

  /** Entries with `starred === true`, most recent first. */
  starred(): RecentEntry[] {
    return this.entries.filter((e) => e.starred === true)
  }

  private schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flushNow()
    }, this.debounceMs)
    /* A pending flush must not keep the process alive: the server is killed
     * with SIGTERM and would otherwise hang for the debounce window. */
    this.timer.unref?.()
  }

  /** Persist immediately, cancelling any pending debounce. */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (!this.dirty) return
    this.dirty = false
    atomicWriteJson(this.file, this.entries)
    this.writes += 1
  }

  /** Page through entries, mirroring the `home:recents` request shape. */
  page(opts: { offset?: number; limit?: number; ext?: string } = {}): {
    entries: RecentEntry[]
    total: number
    totalAll: number
  } {
    const { offset = 0, limit = 50, ext } = opts
    const filtered = ext
      ? this.entries.filter((e) => e.path.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
      : this.entries
    return {
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length,
      totalAll: this.entries.length,
    }
  }
}
