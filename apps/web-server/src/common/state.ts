/**
 * Module-level singletons shared across capability domains.
 *
 * The web-server keeps in-memory state per process (no real DB). Each
 * capability module imports what it needs from here rather than re-declaring
 * Maps, so behaviour matches the legacy single-file implementation exactly.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { atomicWriteJson } from './atomic'
import { join } from 'node:path'

function resolveDataDir(): string {
  const fromEnv =
    process.env.DATA_DIR || process.env.GENOFFICE_DATA_DIR || process.env.GENOFFICE_WEB_DATA_DIR
  if (fromEnv && fromEnv.length > 0) return fromEnv
  return '/tmp/genoffice-data'
}

/**
 * Resolved on first import. We also write the value back into `process.env`
 * so in-process extensions (notably `@genoffice/agent-skills`'s
 * `translate-skill`, which reads `process.env.DATA_DIR` to locate
 * `ai-settings.json`) and any spawned child processes share the same
 * data directory the host uses. Without this back-write, the skill falls
 * back to `~/.genoffice/ai-settings.json` and silently uses the wrong
 * provider (genoffice#W37 regression we keep hitting).
 */
export const DATA_DIR = resolveDataDir()
if (!process.env.DATA_DIR) process.env.DATA_DIR = DATA_DIR
if (!process.env.GENOFFICE_DATA_DIR) process.env.GENOFFICE_DATA_DIR = DATA_DIR
if (!process.env.GENOFFICE_WEB_DATA_DIR) process.env.GENOFFICE_WEB_DATA_DIR = DATA_DIR
mkdirSync(DATA_DIR, { recursive: true })

export const FILES_DIR = join(DATA_DIR, 'files')
mkdirSync(FILES_DIR, { recursive: true })

// ----- Project persistence --------------------------------------------------
export const PROJECTS_FILE = join(DATA_DIR, 'projects.json')

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  files: string[]
}

export function loadProjects(): Project[] {
  try {
    if (existsSync(PROJECTS_FILE)) {
      const data = JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'))
      if (Array.isArray(data) && data.length > 0) return data
    }
  } catch {}
  /* ── Seed a single "Default Project" so the sidebar has something to
   * render on a fresh install. Mirrors the Electron build's first-run
   * experience where users always see at least one project to file into. */
  const now = Date.now()
  const seed: Project[] = [
    {
      id: 'proj-default',
      name: '默认项目',
      createdAt: now,
      updatedAt: now,
      files: [],
    },
  ]
  try {
    atomicWriteJson(PROJECTS_FILE, seed)
  } catch {}
  return seed
}

export function saveProjects(projects: Project[]): void {
  atomicWriteJson(PROJECTS_FILE, projects)
}

// ----- File index -----------------------------------------------------------
export interface FileInfo {
  id: string
  name: string
  path: string
  size: number
  mimeType: string
  createdAt: number
  updatedAt: number
}

export const FILES_INDEX: Map<string, FileInfo> = new Map()

// ----- Recent file lists ---------------------------------------------------
export interface DocInfo {
  id: string
  path: string
  name: string
  openedAt: number
  modified: boolean
}

export const DOCS_RECENT_FILE = join(DATA_DIR, 'docs-recent.json')
export const DOCS_STARRED_FILE = join(DATA_DIR, 'docs-starred.json')

export function loadRecentDocs(): DocInfo[] {
  try {
    if (existsSync(DOCS_RECENT_FILE)) {
      return JSON.parse(readFileSync(DOCS_RECENT_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

/** Row cap for the legacy mirror file. It matches `UnifiedRecents`' own cap:
 *  a smaller number silently truncated the persisted list, so a restart showed
 *  fewer documents than the session that wrote them. */
const LEGACY_RECENTS_ROWS = 200

export function saveRecentDocs(docs: DocInfo[]): void {
  atomicWriteJson(DOCS_RECENT_FILE, pickNewest(docs, LEGACY_RECENTS_ROWS))
}

/**
 * Persisted shape of the starred-docs map. The disk format is just the
 * path -> timestamp map; the home pane reads it through `home:starred`
 * which joins against `DOCS_RECENT` for the user-visible fields.
 */
export function loadStarredDocs(): Array<{ path: string; starredAt: number }> {
  try {
    if (existsSync(DOCS_STARRED_FILE)) {
      const raw = JSON.parse(readFileSync(DOCS_STARRED_FILE, 'utf-8'))
      if (Array.isArray(raw)) {
        return raw.filter(
          (entry): entry is { path: string; starredAt: number } =>
            typeof entry?.path === 'string' && typeof entry?.starredAt === 'number',
        )
      }
    }
  } catch {}
  return []
}

export function saveStarredDocs(
  entries: Array<{ path: string; starredAt: number }> | Map<string, number>,
): void {
  const normalised: Array<{ path: string; starredAt: number }> =
    entries instanceof Map
      ? Array.from(entries, ([path, starredAt]) => ({ path, starredAt }))
      : entries
  atomicWriteJson(DOCS_STARRED_FILE, normalised)
}

export const DOCS_RECENT: Map<string, DocInfo> = new Map()
/**
 * Starred docs — path -> starredAt timestamp. The previous Set<string>
 * dropped on every restart because nothing persisted it; the home pane
 * then silently un-starred everything. The Map shape keeps the membership
 * test cheap and gives us a stable order (most-recent first) for the
 * `home:starred` IPC.
 */
export const DOCS_STARRED: Map<string, number> = new Map()

/** Populate the in-memory recent/starred caches from the on-disk JSON so
 * the home page reflects what was recorded by previous sessions. Idempotent —
 * safe to call from the boot path. */
export function initRecentState(): void {
  try {
    // Starred set first so the disk-sweep below knows which entries to
    // mark as starred when it creates fresh DOCS_RECENT rows.
    for (const entry of loadStarredDocs()) {
      DOCS_STARRED.set(entry.path, entry.starredAt)
    }
  } catch {
    /* A corrupt docs-starred.json is recoverable on the next
     * home:toggle-star; do not let it block boot. */
  }
  try {
    for (const d of loadRecentDocs()) {
      DOCS_RECENT.set(d.path, d)
    }
  } catch {
    /* A corrupt/unreadable docs-recent.json must not abort the boot path —
     * the other two caches below still get seeded. */
  }
  try {
    for (const p of loadRecentSheets()) {
      // SheetInfo has a slightly different shape; we keep path-only entries
      // for the unified recent list
      DOCS_RECENT.set(p.path, {
        id: p.id,
        path: p.path,
        name: p.name,
        openedAt: p.openedAt,
        modified: false,
      })
    }
  } catch {
    /* Same fail-open as above: a bad sheets-recent.json only costs the sheets
     * entries, not the whole recent list. */
  }
  try {
    for (const p of loadRecentSlides()) {
      DOCS_RECENT.set(p.path, {
        id: p.id,
        path: p.path,
        name: p.name,
        openedAt: p.openedAt,
        modified: false,
      })
    }
  } catch {
    /* Same fail-open for slides-recent.json; the disk sweep below is
     * independent of all three JSON caches. */
  }
  /* ── Sweep disk for document artifacts ───────────────────────────────
   * The per-format modules each persist their own recents JSON, and docx has
   * none at all, so a fresh boot left the home grid missing every format that
   * had not happened to be written into one of those files. We walk BOTH
   * FILES_DIR (where uploads and save-as targets land) and DATA_DIR itself
   * (where home:new-* writes its auto-named files). Each match seeds an entry
   * with an mtime-derived openedAt so it sorts naturally, and an entry that is
   * already known keeps its recorded name — the basename on disk is a
   * generated id, not what the user should see in the list. */
  const sweepDirs = [FILES_DIR, DATA_DIR]
  const seen = new Set<string>()
  const now = Date.now()
  for (const dir of sweepDirs) {
    try {
      if (!existsSync(dir)) continue
      for (const entry of readdirSync(dir)) {
        const lower = entry.toLowerCase()
        if (!SWEEP_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue
        const full = join(dir, entry)
        if (seen.has(full) || DOCS_RECENT.has(full)) continue
        seen.add(full)
        let st
        try {
          st = statSync(full)
        } catch {
          continue /* removed between readdir and stat */
        }
        if (!st.isFile()) continue
        DOCS_RECENT.set(full, {
          id: entry.replace(/\.[^.]+$/, ''),
          path: full,
          name: entry,
          openedAt: st.mtimeMs || now,
          modified: false,
        })
      }
    } catch {}
  }
}

/** Extensions the boot sweep adopts from disk. Every format the home grid can
 *  render is listed; a file whose format has no entry here is only reachable
 *  through the channel that created it. */
const SWEEP_EXTENSIONS = [
  '.docx',
  '.xlsx',
  '.pptx',
  '.pdf',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.txt',
  '.csv',
]

export interface SheetInfo {
  id: string
  path: string
  name: string
  openedAt: number
}

/**
 * Keep the newest `n` entries by `openedAt`. Items without an `openedAt` (or
 * with a non-numeric one) sort to the end. The three sibling `saveRecent*`
 * functions used to call `.slice(0, n)` directly, which silently dropped the
 * most recent uploads because Map insertion order has no relation to time —
 * the file kept the oldest `n` entries ever inserted, so the user's recents
 * list lost its newest uploads across a server restart.
 */
function pickNewest<T extends { openedAt?: number }>(items: T[], n: number): T[] {
  return [...items].sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0)).slice(0, n)
}

export const SHEETS_RECENT_FILE = join(DATA_DIR, 'sheets-recent.json')

export function loadRecentSheets(): SheetInfo[] {
  try {
    if (existsSync(SHEETS_RECENT_FILE)) {
      return JSON.parse(readFileSync(SHEETS_RECENT_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveRecentSheets(sheets: SheetInfo[]): void {
  atomicWriteJson(SHEETS_RECENT_FILE, pickNewest(sheets, 10))
}

export interface SlideInfo {
  id: string
  path: string
  name: string
  openedAt: number
}

export const SLIDES_RECENT_FILE = join(DATA_DIR, 'slides-recent.json')

export function loadRecentSlides(): SlideInfo[] {
  try {
    if (existsSync(SLIDES_RECENT_FILE)) {
      return JSON.parse(readFileSync(SLIDES_RECENT_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

export function saveRecentSlides(slides: SlideInfo[]): void {
  atomicWriteJson(SLIDES_RECENT_FILE, pickNewest(slides, 10))
}

// ----- Collab state ---------------------------------------------------------
export const COLLAB_SESSIONS: Map<
  string,
  {
    docId: string
    users: Set<string>
    lastActivity: number
    locks: Map<string, { userId: string; timestamp: number }>
    cursors: Map<
      string,
      {
        position: { x: number; y: number; offset: number }
        selection?: { start: number; end: number }
        timestamp: number
      }
    >
    changes: Array<{
      id: string
      docId: string
      userId: string
      change: unknown
      timestamp: number
      version: number
    }>
  }
> = new Map()

export const PRESENCE: Map<
  string,
  Map<
    string,
    {
      userId: string
      userName: string
      status: 'active' | 'idle' | 'away'
      lastSeen: number
      cursor?: { x: number; y: number; selection?: { start: number; end: number } }
      color: string
    }
  >
> = new Map()

export const DOC_PERMISSIONS: Map<string, Map<string, string>> = new Map()

export interface DocVersion {
  id: string
  content: string
  timestamp: number
  userId: string
  message?: string
}

export interface DocVersionHistory {
  docId: string
  versions: DocVersion[]
}

export const DOC_VERSIONS: Map<string, DocVersionHistory> = new Map()

export interface CommentReply {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: number
}

export interface DocComment {
  id: string
  userId: string
  userName: string
  content: string
  timestamp: number
  resolved: boolean
  replies: CommentReply[]
  selection?: { start: number; end: number; text: string }
}

export const DOC_COMMENTS: Map<string, DocComment[]> = new Map()

export interface DocTemplate {
  id: string
  name: string
  type: 'docs' | 'sheets' | 'slides'
  content: string
  thumbnail?: string
  category: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export const TEMPLATES: Map<string, DocTemplate> = new Map()

export function initDefaultTemplates(): void {
  if (TEMPLATES.size > 0) return
  const defaultTemplates = [
    {
      id: 'tpl-resume',
      name: '简历',
      type: 'docs' as const,
      content: '<h1>个人简历</h1>',
      category: '办公',
      tags: ['简历', '个人'],
    },
    {
      id: 'tpl-report',
      name: '工作报告',
      type: 'docs' as const,
      content: '<h1>工作报告</h1>',
      category: '办公',
      tags: ['报告', '工作'],
    },
    {
      id: 'tpl-presentation',
      name: '商务演示',
      type: 'slides' as const,
      content: '[]',
      category: '演示',
      tags: ['演示', '商务'],
    },
  ]

  for (const tpl of defaultTemplates) {
    TEMPLATES.set(tpl.id, {
      ...tpl,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
}

// ----- Enterprise / shell state --------------------------------------------
export const CLOUD_FILES: Map<
  string,
  {
    id: string
    name: string
    size: number
    type: string
    url: string
    createdAt: number
    updatedAt: number
    public: boolean
  }
> = new Map()

export const OFFLINE_QUEUE: Map<
  string,
  {
    id: string
    action: string
    payload: unknown
    timestamp: number
    synced: boolean
  }
> = new Map()

export const SEARCH_INDEX: Map<
  string,
  {
    id: string
    type: string
    title: string
    content: string
    tags: string[]
    createdAt: number
  }
> = new Map()

export interface UserRecord {
  id: string
  name: string
  email: string
  role: 'admin' | 'editor' | 'viewer'
  createdAt: number
}

export const USERS: Map<string, UserRecord> = new Map()

export const PERMISSIONS: Map<string, Map<string, string[]>> = new Map()

export interface TenantRecord {
  id: string
  name: string
  domain: string
  plan: 'free' | 'pro' | 'enterprise'
  settings: Record<string, unknown>
  createdAt: number
  status: 'active' | 'suspended' | 'trial'
}

export const TENANTS: Map<string, TenantRecord> = new Map()

export interface MailRecord {
  id: string
  tenantId: string
  from: { name: string; email: string }
  to: Array<{ name: string; email: string }>
  /** Carbon-copy recipients; absent when the sender passed none. */
  cc?: Array<{ name: string; email: string }>
  /** Blind carbon-copy recipients; absent when the sender passed none. */
  bcc?: Array<{ name: string; email: string }>
  subject: string
  body: string
  attachments: Array<{ name: string; size: number }>
  sentAt: number
  status: 'sent' | 'failed' | 'pending'
}

export const MAILS: Map<string, MailRecord> = new Map()

export interface CalendarEventRecord {
  id: string
  tenantId: string
  title: string
  description: string
  startTime: number
  endTime: number
  attendees: Array<{ name: string; email: string; status: 'pending' | 'accepted' | 'declined' }>
  location?: string
  reminders: number[]
  recurrence?: string
  status: 'confirmed' | 'cancelled' | 'tentative'
}

export const CALENDARS: Map<string, CalendarEventRecord> = new Map()

export interface WorkflowRecord {
  id: string
  tenantId: string
  name: string
  description: string
  steps: Array<{
    id: string
    type: 'approval' | 'notification' | 'condition' | 'integration'
    config: Record<string, unknown>
    next?: string
  }>
  triggers: string[]
  status: 'active' | 'paused' | 'archived'
  createdAt: number
}

export const WORKFLOWS: Map<string, WorkflowRecord> = new Map()

export interface AuditRecord {
  id: string
  tenantId: string
  userId: string
  action: string
  resource: string
  resourceId: string
  details: Record<string, unknown>
  ip: string
  userAgent: string
  timestamp: number
  status: 'success' | 'failure'
}

export const AUDIT_LOGS: Map<string, AuditRecord> = new Map()

export interface NotificationRecord {
  id: string
  type: 'info' | 'success' | 'warning' | 'error'
  title: string
  message: string
  timestamp: number
  read: boolean
}

export const NOTIFICATIONS: Map<string, NotificationRecord[]> = new Map()

export const WEB_WINDOWS: Map<string, { url: string; name: string }> = new Map()

export interface TabRecord {
  id: string
  type: string
  title: string
  path?: string
}

export const TABS: Map<string, TabRecord> = new Map()
