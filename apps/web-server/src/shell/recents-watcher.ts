/**
 * Watch `FILES_DIR` so a file dropped in by any route — drag-and-drop, an
 * `mv` in a terminal, a sync client — shows up in the home grid without the
 * user having to open it first.
 *
 * `fs.watch` is used rather than a polling scan because the directory can hold
 * thousands of files and a poll would re-stat all of them on a timer. The
 * tradeoff is that `fs.watch` reports the *directory* changed, not which entry,
 * so the callback re-reads the directory. That is cheap (one `readdir`) and
 * avoids depending on `filename` being populated, which is platform-specific.
 *
 * Two failure modes are absorbed rather than propagated:
 *   • `fs.watch` can throw `EPERM` on network filesystems and in some
 *     containers. The rest of the IPC surface must still work, so the watcher
 *     simply does not attach.
 *   • Events arrive in bursts (a copy writes a file in chunks), so additions
 *     are debounced into one recents flush.
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { log } from '../common/logger'
import type { UnifiedRecents } from '@genoffice/file-management'

/**
 * Extensions the watcher records. `.docx` is deliberately absent: documents
 * are added by their own save channel, and recording them here would make every
 * autosave reorder the home grid mid-edit.
 */
const WATCHED_EXTENSIONS = ['.pdf', '.md', '.markdown', '.html', '.htm', '.txt']

const DEBOUNCE_MS = 300

let watcher: FSWatcher | null = null

export interface RecentsWatcherOptions {
  filesDir: string
  recents: UnifiedRecents
  debounceMs?: number
  /** Called for every path that was added, so a caller can mirror it into the
   *  in-session recents map. */
  onAdded?: (path: string) => void
  onRemoved?: (path: string) => void
}

/**
 * Attach the watcher. Idempotent: a second call is a no-op, because two
 * watchers would double every recents write.
 */
export function setupRecentsFileWatcher(options: RecentsWatcherOptions): void {
  if (watcher) return
  const { filesDir, recents, debounceMs = DEBOUNCE_MS, onAdded, onRemoved } = options
  if (!existsSync(filesDir)) return

  /** Paths seen by the previous scan, and their mtimes: a file that changed is
   *  treated as an addition so an overwrite re-surfaces in the grid. */
  let known = new Map<string, number>()
  let timer: NodeJS.Timeout | undefined

  const scan = (options: { seed?: boolean } = {}): void => {
    timer = undefined
    /* A seed pass only populates the baseline. It must not emit additions:
     * at boot every pre-existing file would look "new", and the add would
     * overwrite the name the save channel recorded with the generated
     * on-disk basename — the home grid then shows `7f3a…-report.pdf`
     * instead of `report.pdf` for every watched extension. */
    const seeding = options.seed === true
    let names: string[]
    try {
      names = readdirSync(filesDir)
    } catch (error) {
      log.warn('recents-watcher', 'readdir failed', { err: error })
      return
    }
    const current = new Map<string, number>()
    for (const name of names) {
      /* Dot-entries are internal state: `.trash/` holds soft-deleted files,
       * and re-adding them would resurrect a document the user just deleted. */
      if (name.startsWith('.')) continue
      const lower = name.toLowerCase()
      if (!WATCHED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
      const path = join(filesDir, name)
      let mtimeMs: number
      try {
        const stats = statSync(path)
        if (!stats.isFile()) continue
        mtimeMs = stats.mtimeMs
      } catch {
        continue
      }
      current.set(path, mtimeMs)
      if (known.get(path) === mtimeMs) continue
      known.set(path, mtimeMs)
      if (seeding) continue
      /* An entry that is already listed keeps its name: the basename on disk
       * is the generated id, not what the user should see. */
      const named = recents.get(path) ? { modified: true } : { name, modified: true }
      void Promise.resolve(recents.add(path, named))
        .then(() => onAdded?.(path))
        .catch((error) => log.warn('recents-watcher', 'recents add failed', { err: error, path }))
    }
    /* Deletions: a path that was known and is gone. Without this the grid kept
     * offering a row for a file removed from another window. */
    for (const path of known.keys()) {
      if (!current.has(path)) {
        known.delete(path)
        void Promise.resolve(recents.remove(path))
          .then((removed) => {
            if (removed) onRemoved?.(path)
          })
          .catch((error) =>
            log.warn('recents-watcher', 'recents remove failed', { err: error, path }),
          )
      }
    }
    known = current
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(scan, debounceMs)
  }

  try {
    watcher = watch(filesDir, { persistent: false }, schedule)
    watcher.on('error', (error) => {
      log.warn('recents-watcher', 'watcher error; recents will not auto-update', { err: error })
    })
  } catch (error) {
    /* EPERM on network mounts / restricted containers: not fatal. Recents
     * still works through the explicit save channels. */
    log.warn('recents-watcher', 'could not watch FILES_DIR', { err: error })
    return
  }
  /* Seed the baseline so the first real event is a delta rather than recording
   * every pre-existing file as newly added. */
  known = new Map()
  scan({ seed: true })
}

/** Detach the watcher. Used by tests that boot the server more than once. */
export function stopRecentsFileWatcher(): void {
  if (!watcher) return
  try {
    watcher.close()
  } catch {
    /* already closed */
  }
  watcher = null
}
