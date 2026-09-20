/**
 * Ranked history of directories the user saved into, backing the Save As
 * dialog's "recent folders" list.
 *
 * Ranking is by use count as well as recency: a user who saves into
 * `~/Documents/Reports` forty times should see it above a directory they
 * visited once five minutes ago. Both signals are stored so the sort does not
 * have to be recomputed from a log.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJson } from './atomic'

export interface SaveLocation {
  path: string
  /** Epoch ms of the most recent save into this directory. */
  lastUsedAt: number
  /** How many times a save landed here. */
  uses: number
}

export class SaveLocations {
  private entries: SaveLocation[] = []

  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now(),
    private readonly maxEntries = 20,
  ) {
    this.entries = this.read()
  }

  private read(): SaveLocation[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf-8'))
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (e): e is SaveLocation =>
          !!e && typeof e === 'object' && typeof (e as SaveLocation).path === 'string',
      )
    } catch {
      return []
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    atomicWriteJson(this.file, this.entries)
  }

  /**
   * Ranked most-useful first: use count dominates, recency breaks ties.
   *
   * Count-first is deliberate. Sorting by recency alone made the list churn
   * on every save, so the directory the user actually works in kept sliding
   * out of reach behind one-off visits.
   */
  list(): SaveLocation[] {
    return [...this.entries].sort((a, b) => b.uses - a.uses || b.lastUsedAt - a.lastUsedAt)
  }

  record(path: string): SaveLocation {
    const existing = this.entries.find((e) => e.path === path)
    if (existing) {
      existing.uses += 1
      existing.lastUsedAt = this.now()
      this.persist()
      return existing
    }
    const entry: SaveLocation = { path, lastUsedAt: this.now(), uses: 1 }
    this.entries = [entry, ...this.entries].slice(0, this.maxEntries)
    this.persist()
    return entry
  }

  forget(path: string): boolean {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.path !== path)
    if (this.entries.length === before) return false
    this.persist()
    return true
  }
}
