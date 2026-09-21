/**
 * Watch the active storage backend so a file dropped in by any route —
 * drag-and-drop, an `mv` in a terminal, a sync client, an S3 PUT from
 * another process — shows up in the home grid without the user having
 * to open it first.
 *
 * The strategy depends on the backend:
 *   - `local` uses `fs.watch` for instant notifications.
 *   - any other backend (MinIO/S3/rustfs) polls `backend.list()` every
 *     30s — there's no inotify for a remote bucket, so polling is the
 *     only honest option. The 30s window matches the staging/SSO
 *     expectations operators set; tune via `pollIntervalMs`.
 *
 * `fs.watch` is used rather than a polling scan for local because the
 * directory can hold thousands of files and a poll would re-stat all of
 * them on a timer. The tradeoff is that `fs.watch` reports the
 * *directory* changed, not which entry, so the callback re-reads the
 * directory. That is cheap (one `readdir`) and avoids depending on
 * `filename` being populated, which is platform-specific.
 *
 * Two failure modes are absorbed rather than propagated:
 *   • `fs.watch` can throw `EPERM` on network filesystems and in some
 *     containers. The rest of the IPC surface must still work, so the
 *     watcher simply does not attach.
 *   • Events arrive in bursts (a copy writes a file in chunks), so
 *     additions are debounced into one recents flush.
 */
import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { log } from '../common/logger'
import { getStorageBackend } from '../common/state'
import type { StorageBackend, UnifiedRecents } from '@genoffice/file-management'

/**
 * Extensions the watcher records. `.docx` is deliberately absent: documents
 * are added by their own save channel, and recording them here would make every
 * autosave reorder the home grid mid-edit.
 */
const WATCHED_EXTENSIONS = ['.pdf', '.md', '.markdown', '.html', '.htm', '.txt']

const DEBOUNCE_MS = 300
/** Default poll cadence for non-local backends. 30s matches the cadence
 *  operators expect for "recently uploaded" semantics on a shared bucket. */
const REMOTE_POLL_INTERVAL_MS = 30_000

let localWatcher: FSWatcher | null = null
let remotePollTimer: NodeJS.Timeout | null = null

export interface RecentsWatcherOptions {
  filesDir: string
  recents: UnifiedRecents
  debounceMs?: number
  /** Override the poll cadence for remote backends. Defaults to 30s. */
  pollIntervalMs?: number
  /** Called for every path that was added, so a caller can mirror it into the
   *  in-session recents map. */
  onAdded?: (path: string) => void
  onRemoved?: (path: string) => void
}

/**
 * Attach the watcher. Idempotent: a second call is a no-op, because two
 * watchers would double every recents write. Selects local fs.watch or
 * remote polling based on the active backend at call time.
 */
export function setupRecentsFileWatcher(options: RecentsWatcherOptions): void {
  if (localWatcher || remotePollTimer) return
  const backend = getStorageBackend()
  if (backend.id === 'local') {
    setupLocalWatcher(options, backend)
  } else {
    setupRemotePoller(options, backend, options.pollIntervalMs ?? REMOTE_POLL_INTERVAL_MS)
  }
}

function setupLocalWatcher(options: RecentsWatcherOptions, _backend: StorageBackend): void {
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
    localWatcher = watch(filesDir, { persistent: false }, schedule)
    localWatcher.on('error', (error) => {
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

function setupRemotePoller(
  options: RecentsWatcherOptions,
  backend: StorageBackend,
  intervalMs: number,
): void {
  const { recents, onAdded, onRemoved } = options
  /* Tracked by storage key (not absolute path) so we surface the right
   * `storage://<backend>/<key>` URI to the recents store. */
  let known = new Map<string, number>()

  const scan = async (): Promise<void> => {
    let entries
    try {
      entries = await backend.list('')
    } catch (err) {
      log.warn('recents-watcher', 'remote list failed', { err, backend: backend.id })
      return
    }
    const current = new Map<string, number>()
    for (const entry of entries) {
      /* Skip dot entries (trash namespace, _internal file). */
      const firstSeg = entry.key.split('/')[0]
      if (firstSeg.startsWith('.')) continue
      const lastSeg = entry.key.split('/').pop() ?? ''
      const lower = lastSeg.toLowerCase()
      if (!WATCHED_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
      /* mtime is optional on remote backends; fall back to 0 so the entry
       * still triggers an "add" once and then stays. */
      const mtimeMs = entry.modifiedAt ? Date.parse(entry.modifiedAt) : 0
      current.set(entry.key, mtimeMs)
      if (known.get(entry.key) === mtimeMs) continue
      known.set(entry.key, mtimeMs)
      const path = `storage://${backend.id}/${entry.key}`
      /* Without mtime we can't tell "newly added" from "always here", so
       * only treat non-zero mtime as a real change. */
      if (mtimeMs === 0 && known.size > 1) continue
      try {
        await recents.add(path, { name: lastSeg, modified: true })
        onAdded?.(path)
      } catch (err) {
        log.warn('recents-watcher', 'recents add failed', { err, path })
      }
    }
    for (const [key] of known) {
      if (!current.has(key)) {
        known.delete(key)
        const path = `storage://${backend.id}/${key}`
        try {
          const removed = await recents.remove(path)
          if (removed) onRemoved?.(path)
        } catch (err) {
          log.warn('recents-watcher', 'recents remove failed', { err, path })
        }
      }
    }
  }

  /* Seed immediately, then poll on the interval. Errors are swallowed so
   * a transient bucket hiccup doesn't kill the watcher; the next tick
   * retries. */
  void scan()
  remotePollTimer = setInterval(() => {
    void scan()
  }, intervalMs)
}

/** Detach the watcher. Used by tests that boot the server more than once. */
export function stopRecentsFileWatcher(): void {
  if (localWatcher) {
    try {
      localWatcher.close()
    } catch {
      /* already closed */
    }
    localWatcher = null
  }
  if (remotePollTimer) {
    clearInterval(remotePollTimer)
    remotePollTimer = null
  }
}
