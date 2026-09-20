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

export const RECENTS_FILE = join(DATA_DIR, 'recents.json')

/** Restart-safe recents. Debounced, so a burst of saves is one write. */
export const unifiedRecents = new UnifiedRecents(RECENTS_FILE, { debounceMs: 250 })

export const trash = new Trash(DATA_DIR)

export const saveLocations = new SaveLocations(join(DATA_DIR, 'save-locations.json'))

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
