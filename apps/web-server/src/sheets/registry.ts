/**
 * Session registry for the web-server's sheets save pipeline.
 *
 * The desktop main process keeps a `Map<sessionId, SessionInfo>` alongside
 * the in-process xlsx-sidecar, with each entry holding the resolved
 * `sourcePath`, the active `targetPath`, and enough format metadata to
 * route `.csv` saves back to the CSV export channel. The web build never
 * had the counterpart, so `workbook:save` was a stub and every save
 * attempt returned `WEB_UNSUPPORTED`.
 *
 * This module is the home for the same Map. Both `workbook:open-path`
 * (which already stages storage URIs into FILES_DIR and mints a
 * sessionId) and `workbook:read-range` consult it to look up the
 * source path; `workbook:save` reads it to find the bytes to patch.
 *
 * The Map is LRU-bounded: a long-running server with a renderer that
 * keeps opening new tabs would otherwise accumulate stale sessions and
 * hold their snapshot bytes until the process restarts. The eviction
 * path writes a final copy of the staged bytes back to the FILES_DIR
 * canonical path so a re-open after eviction re-reads from disk rather
 * than seeing an empty workbook.
 */
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FILES_DIR } from '../common/index'
import { WEB_TEMP_ROOT } from '../common/paths'
import { fileIndexStore } from '../common/file-index-store'

export type WorkbookFormat = 'xlsx' | 'xlsm' | 'csv' | 'xls'

export interface WorkbookSessionInfo {
  /** The bytes this session's pending edits were made against. Save
   *  uses this as the patch base (see `apps/sheets/src/main/sheets-main.ts`
   *  `snapshotWorkbook` for the desktop equivalent). */
  readonly sessionId: string
  /** Absolute path on disk for the session's source bytes. */
  readonly sourcePath: string
  /** Resolved on first save; the renderer may have asked for a new path
   *  via save-as. When undefined the save uses `sourcePath` as the
   *  target too, matching the desktop "save over source" behaviour. */
  readonly targetPath: string
  /** Detected at open time: `.xlsx`, `.xlsm`, `.csv`, or `.xls`. */
  readonly format: WorkbookFormat
  /** When the open path was a storage URI, the staged FILES_DIR copy
   *  is recorded here so the eviction policy knows what to remove. */
  readonly staged?: string
  /** Last-touched timestamp; LRU eviction sweeps the oldest entry. */
  lastTouchedAt: number
}

const MAX_SESSIONS = 64
/** Root for snapshots. The desktop keeps these in the OS temp dir; we
 *  reuse WEB_TEMP_ROOT so an operator's `rm -rf` of `/tmp` does not
 *  touch our state, and so the data dir sweeper's heuristics (entry
 *  starts with `upload-`) leave snapshots alone. */
const SNAPSHOT_DIR = join(WEB_TEMP_ROOT, 'xlsx-snapshots')

const sessions = new Map<string, WorkbookSessionInfo>()

function touch(info: WorkbookSessionInfo): void {
  info.lastTouchedAt = Date.now()
}

/** Register a freshly opened workbook. Returns the (possibly re-keyed)
 *  sessionId. Callers should echo this back in subsequent IPC calls. */
export function registerSession(input: Omit<WorkbookSessionInfo, 'lastTouchedAt'>): WorkbookSessionInfo {
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  const info: WorkbookSessionInfo = { ...input, lastTouchedAt: Date.now() }
  sessions.set(info.sessionId, info)
  evictIfNeeded()
  return info
}

/** Look up a session by id. Returns undefined if the session has been
 *  evicted (e.g. after a server restart the renderer-supplied id no
 *  longer matches; the renderer should re-open). */
export function getSession(sessionId: string): WorkbookSessionInfo | undefined {
  const info = sessions.get(sessionId)
  if (info) touch(info)
  return info
}

/** Update the session's resolved target path (used by `workbook:save-as`). */
export function updateTarget(sessionId: string, targetPath: string): void {
  const info = sessions.get(sessionId)
  if (info) {
    sessions.set(sessionId, { ...info, targetPath, lastTouchedAt: Date.now() })
  }
}

/** Drop the session. If the staged bytes belong to this server only,
 *  also clean them up; the storage-backed ones stay (they're indexed
 *  and reachable through `files:read`). */
export function forgetSession(sessionId: string): void {
  const info = sessions.get(sessionId)
  if (!info) return
  sessions.delete(sessionId)
  if (info.staged && existsSync(info.staged)) {
    try {
      unlinkSync(info.staged)
    } catch {
      /* best effort */
    }
  }
}

/** Promote the staged snapshot to a stable FILES_DIR location so a
 *  subsequent re-open of the same workbook can find it. Called by the
 *  save pipeline once a save has succeeded and `targetPath` is the
 *  authoritative on-disk location. */
export function promoteSnapshot(sessionId: string, targetPath: string): void {
  const info = sessions.get(sessionId)
  if (!info?.staged) return
  try {
    mkdirSync(dirname(targetPath), { recursive: true })
    if (existsSync(info.staged) && info.staged !== targetPath) {
      copyFileSync(info.staged, targetPath)
    }
  } catch {
    /* promotion is best-effort; the canonical target was already in place */
  }
}

/** Snapshot path for a new session — picked once at open time so the
 *  save pipeline always patches the bytes this session was opened
 *  against, regardless of any external writes to the source file. */
export function newSnapshotPath(sessionId: string): string {
  mkdirSync(SNAPSHOT_DIR, { recursive: true })
  // `<sessionId>.xlsx` always keeps the `.xlsx` suffix so the sidecar's
  // extension-based parser recognises it as a workbook; the sessionId
  // alone is collision-free because it is a UUID minted by the renderer.
  return join(SNAPSHOT_DIR, `${sessionId}.xlsx`)
}

/** LRU eviction. When the registry is at capacity, drop the oldest
 *  non-current entry and (best-effort) write its snapshot back to the
 *  FILES_DIR canonical location so a re-open does not see an empty
 *  workbook. */
function evictIfNeeded(): void {
  if (sessions.size <= MAX_SESSIONS) return
  let oldestId: string | null = null
  let oldestTime = Number.POSITIVE_INFINITY
  for (const [id, info] of sessions) {
    if (info.lastTouchedAt < oldestTime) {
      oldestTime = info.lastTouchedAt
      oldestId = id
    }
  }
  if (oldestId) forgetSession(oldestId)
}

/** Diagnostic: snapshot the live registry for tests. */
export function snapshotSessions(): Array<Pick<WorkbookSessionInfo, 'sessionId' | 'format'>> {
  return [...sessions.values()].map((info) => ({
    sessionId: info.sessionId,
    format: info.format,
  }))
}

/** True if the file extension is a workbook we know how to round-trip. */
export function detectFormat(path: string): WorkbookFormat {
  const lower = path.toLowerCase()
  if (lower.endsWith('.xlsm')) return 'xlsm'
  if (lower.endsWith('.csv')) return 'csv'
  if (lower.endsWith('.xls')) return 'xls'
  return 'xlsx'
}

/** `xlsx-sidecar` snapshots are written here; expose so the save
 *  pipeline can sweep stale ones on boot. */
export function snapshotDir(): string {
  return SNAPSHOT_DIR
}

/** Re-export so `index.ts` doesn't have to import the package-level
 *  constants directly. */
export { FILES_DIR }
export { fileIndexStore }
