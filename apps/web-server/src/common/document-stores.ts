/**
 * The pre-wired singleton stores.
 *
 * The stores are stateless with respect to each other and expensive to build
 * (each resolves the data directory and hashes bytes), so the server builds
 * them once at boot and every handler shares the instance. Keeping the wiring
 * here — rather than in each handler module — is what stops a new channel from
 * quietly constructing its own store with a different `filesDir`.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  HtmlStore,
  MarkdownStore,
  DocsStore,
  SaveLocations,
  Trash,
  UnifiedRecents,
  VersionHistory,
  type DocumentStoreHost,
} from '@genoffice/file-management'
import {
  DATA_DIR,
  DOCS_RECENT,
  FILES_DIR,
  loadProjects,
  saveProjects,
  saveRecentDocs,
} from './state'
import { getStorageBackend } from './state'

export const RECENTS_FILE = join(DATA_DIR, 'recents.json')

/** Restart-safe recents. Debounced, so a burst of saves is one write. */
export const unifiedRecents = new UnifiedRecents(RECENTS_FILE, { debounceMs: 250 })

/** Lazily-initialised Trash that wires the active storage backend.
 *  Re-evaluated each call so a backend swap at runtime (e.g. an operator
 *  editing env and restarting) lands on the next request without needing
 *  to reload the singleton module. */
let _trash: Trash | null = null
export function getTrash(): Trash {
  if (!_trash) _trash = new Trash(DATA_DIR, getStorageBackend())
  return _trash
}

/** Back-compat alias. New callers should prefer `getTrash()` so the
 *  backend is read on each call rather than captured at module load. */
export const trash = {
  delete: (key: string) => getTrash().delete(key),
  list: () => getTrash().list(),
  restore: (id: string) => getTrash().restore(id),
  purge: (id: string) => getTrash().purge(id),
  has: (key: string) => getTrash().has(key),
  storedKeys: () => getTrash().storedKeys(),
}

export const saveLocations = new SaveLocations(join(DATA_DIR, 'save-locations.json'))

/** VersionHistory is still local-only in this iteration — the snapshot
 *  semantics (`<key>.v<n>` siblings) work but the dedupe logic depends on
 *  listing the snapshot directory, which only the local backend supports
 *  cheaply. Wire the backend here once that lands. */
export const versions = new VersionHistory(DATA_DIR)

/** Record `path` in the project's file list, creating the list if needed. */
function attachToProject(projectId: string, path: string): void {
  try {
    const projects = loadProjects()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return
    if (!project.files.includes(path)) {
      project.files.push(path)
      project.updatedAt = Date.now()
      saveProjects(projects)
    }
  } catch {
    /* A project write failure must not fail the save that triggered it: the
     * document itself is already safely on disk. */
  }
}

export const storeHost: DocumentStoreHost = {
  filesDir: FILES_DIR,
  dataDir: DATA_DIR,
  recents: unifiedRecents,
  attachToProject,
  hashBytes: (bytes) => createHash('sha256').update(bytes).digest('hex'),
}

export const docsStore = new DocsStore(storeHost)
export const markdownStore = new MarkdownStore(storeHost)
export const htmlStore = new HtmlStore(storeHost)

/**
 * Flush every debounced writer. Called from the shutdown path so a SIGTERM
 * does not discard the last few seconds of recents.
 */
export function flushFileManagementState(): void {
  try {
    unifiedRecents.flushNow()
  } catch {
    /* nothing useful to do during shutdown */
  }
  /* SaveLocations writes eagerly (each record is a deliberate user action,
   * not a burst), so it has nothing buffered to flush. */
}

/* ── Legacy recents mirror ───────────────────────────────────────────
 * `home:recents` reads the in-session `DOCS_RECENT` map, while
 * `unifiedRecents` is what survives a restart. Any write that only reaches
 * one of the two is user-visible as a bug: a saved document that is missing
 * from the home grid until the next boot, or an entry that vanishes on
 * restart. Every save path goes through these two helpers so the mirror can
 * never drift again.
 */
const MAX_RECENT_DOCS = 500

function evictOldestRecentDoc(): void {
  let oldestPath: string | null = null
  let oldestTime = Infinity
  for (const [p, d] of DOCS_RECENT) {
    if ((d.openedAt ?? 0) < oldestTime) {
      oldestTime = d.openedAt ?? 0
      oldestPath = p
    }
  }
  if (oldestPath) DOCS_RECENT.delete(oldestPath)
}

export function mirrorRecentDoc(
  path: string,
  fields: { name?: string; id?: string; modified?: boolean } = {},
): void {
  const existing = DOCS_RECENT.get(path)
  DOCS_RECENT.set(path, {
    id: fields.id ?? existing?.id ?? path,
    path,
    name: fields.name ?? existing?.name ?? path.split('/').pop() ?? path,
    openedAt: Date.now(),
    modified: fields.modified ?? existing?.modified ?? false,
  })
  if (!existing && DOCS_RECENT.size > MAX_RECENT_DOCS) evictOldestRecentDoc()
  saveRecentDocs([...DOCS_RECENT.values()])
}

/** Drop `path` from the legacy in-session recents map and persist. */
export function forgetRecentDoc(path: string): void {
  if (!DOCS_RECENT.delete(path)) return
  saveRecentDocs([...DOCS_RECENT.values()])
}

/** Record a path in both the legacy mirror and the restart-safe store. */
export async function recordRecentDoc(
  path: string,
  fields: { name?: string; id?: string; modified?: boolean; projectId?: string } = {},
): Promise<void> {
  mirrorRecentDoc(path, fields)
  await unifiedRecents.add(path, {
    name: fields.name,
    modified: fields.modified ?? false,
    projectId: fields.projectId,
  })
}
