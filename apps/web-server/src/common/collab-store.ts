/**
 * Disk-backed persistence for the in-memory collab Maps.
 *
 * Background: collab state (sessions, presence, comments, versions, templates)
 * used to live entirely in process-local Maps. A server restart wiped it.
 * This module adds a JSON-on-disk mirror with `atomicWriteJson` for crash
 * safety and lazy boot rehydration.
 *
 * # Write strategy
 *
 * Every collab write handler in `src/collab/*.ts` calls the matching
 * `save*()` helper immediately after mutating the in-memory Map. The save is
 * best-effort: a write failure is logged but never thrown, because losing
 * one round of cursor moves is preferable to wedging the IPC handler.
 *
 * # Read strategy
 *
 * `loadCollabStore()` runs once at boot (called from `src/index.ts` right
 * after `initRecentState()`). Each Map is loaded from its own file. A
 * missing file, a parse error, or a malformed shape all degrade to an empty
 * Map — the same defensive posture as `loadProjects()`.
 *
 * # Serialisation
 *
 * `Set<string>` becomes `string[]`; `Map<K, V>` becomes `[K, V][]`.
 * The reverse restore is in `loadCollabStore()`. We never persist the
 * live Maps directly because `JSON.stringify` on a Map/Set yields `{}`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from './atomic'
import { DATA_DIR } from './state'
import {
  COLLAB_SESSIONS,
  PRESENCE,
  DOC_PERMISSIONS,
  DOC_VERSIONS,
  DOC_COMMENTS,
  TEMPLATES,
} from './state'

const COLLAB_SESSIONS_FILE = join(DATA_DIR, 'collab-sessions.json')
const PRESENCE_FILE = join(DATA_DIR, 'collab-presence.json')
const DOC_PERMISSIONS_FILE = join(DATA_DIR, 'doc-permissions.json')
const DOC_VERSIONS_FILE = join(DATA_DIR, 'doc-versions.json')
const DOC_COMMENTS_FILE = join(DATA_DIR, 'doc-comments.json')
const TEMPLATES_FILE = join(DATA_DIR, 'templates.json')

function safeReadJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    if (raw.length === 0) return null
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function safeWrite(path: string, value: unknown): void {
  try {
    atomicWriteJson(path, value)
  } catch (err) {
    console.warn(`[collab-store] write failed for ${path}:`, err)
  }
}

// --------------------------------------------------------------------------
// COLLAB_SESSIONS — docId → { users:Set, lastActivity, locks:Map, cursors:Map, changes:[] }
// --------------------------------------------------------------------------

interface PersistedCollabSession {
  docId: string
  users: string[]
  lastActivity: number
  locks: Array<[string, { userId: string; timestamp: number }]>
  cursors: Array<[
    string,
    {
      position: { x: number; y: number; offset: number }
      selection?: { start: number; end: number }
      timestamp: number
    },
  ]>
  changes: Array<{
    id: string
    docId: string
    userId: string
    change: unknown
    timestamp: number
    version: number
  }>
}

export function saveCollabSessions(): void {
  const payload: Array<[string, PersistedCollabSession]> = []
  for (const [docId, session] of COLLAB_SESSIONS) {
    payload.push([
      docId,
      {
        docId: session.docId,
        users: [...session.users],
        lastActivity: session.lastActivity,
        locks: [...session.locks.entries()],
        cursors: [...session.cursors.entries()],
        changes: session.changes,
      },
    ])
  }
  safeWrite(COLLAB_SESSIONS_FILE, payload)
}

// --------------------------------------------------------------------------
// PRESENCE — docId → userId → { userId, userName, status, lastSeen, cursor?, color }
// --------------------------------------------------------------------------

interface PersistedPresenceEntry {
  userId: string
  userName: string
  status: 'active' | 'idle' | 'away'
  lastSeen: number
  cursor?: { x: number; y: number; selection?: { start: number; end: number } }
  color: string
}

export function savePresence(): void {
  const payload: Array<[string, Array<[string, PersistedPresenceEntry]>]> = []
  for (const [docId, docPresence] of PRESENCE) {
    payload.push([docId, [...docPresence.entries()]])
  }
  safeWrite(PRESENCE_FILE, payload)
}

// --------------------------------------------------------------------------
// DOC_PERMISSIONS — docId → userId → permission
// --------------------------------------------------------------------------

export function saveDocPermissions(): void {
  const payload: Array<[string, Array<[string, string]>]> = []
  for (const [docId, perms] of DOC_PERMISSIONS) {
    payload.push([docId, [...perms.entries()]])
  }
  safeWrite(DOC_PERMISSIONS_FILE, payload)
}

// --------------------------------------------------------------------------
// DOC_VERSIONS — docId → { docId, versions:[] }
// --------------------------------------------------------------------------

interface PersistedVersionHistory {
  docId: string
  versions: Array<{
    id: string
    content: string
    timestamp: number
    userId: string
    message?: string
  }>
}

export function saveDocVersions(): void {
  const payload: Array<[string, PersistedVersionHistory]> = []
  for (const [docId, history] of DOC_VERSIONS) {
    payload.push([docId, { docId, versions: history.versions }])
  }
  safeWrite(DOC_VERSIONS_FILE, payload)
}

// --------------------------------------------------------------------------
// DOC_COMMENTS — docId → comments[]
// --------------------------------------------------------------------------

export function saveDocComments(): void {
  const payload: Array<[string, unknown]> = []
  for (const [docId, comments] of DOC_COMMENTS) {
    payload.push([docId, comments])
  }
  safeWrite(DOC_COMMENTS_FILE, payload)
}

// --------------------------------------------------------------------------
// TEMPLATES — global Map<id, template>
// --------------------------------------------------------------------------

export function saveTemplates(): void {
  safeWrite(TEMPLATES_FILE, [...TEMPLATES.entries()])
}

// --------------------------------------------------------------------------
// Boot rehydration
// --------------------------------------------------------------------------

export function loadCollabStore(): void {
  // COLLAB_SESSIONS
  const persistedSessions = safeReadJson<Array<[string, PersistedCollabSession]>>(COLLAB_SESSIONS_FILE)
  if (Array.isArray(persistedSessions)) {
    for (const [docId, raw] of persistedSessions) {
      if (!raw || typeof raw !== 'object') continue
      COLLAB_SESSIONS.set(docId, {
        docId: raw.docId ?? docId,
        users: new Set(Array.isArray(raw.users) ? raw.users : []),
        lastActivity: typeof raw.lastActivity === 'number' ? raw.lastActivity : Date.now(),
        locks: new Map(Array.isArray(raw.locks) ? raw.locks : []),
        cursors: new Map(Array.isArray(raw.cursors) ? raw.cursors : []),
        changes: Array.isArray(raw.changes) ? raw.changes : [],
      })
    }
  }

  // PRESENCE
  const persistedPresence = safeReadJson<Array<[string, Array<[string, PersistedPresenceEntry]>]>>(PRESENCE_FILE)
  if (Array.isArray(persistedPresence)) {
    for (const [docId, entries] of persistedPresence) {
      if (!Array.isArray(entries)) continue
      const inner = new Map<string, PersistedPresenceEntry>()
      for (const [userId, entry] of entries) {
        if (entry && typeof entry === 'object' && typeof entry.userId === 'string') {
          inner.set(userId, entry)
        }
      }
      PRESENCE.set(docId, inner)
    }
  }

  // DOC_PERMISSIONS
  const persistedPerms = safeReadJson<Array<[string, Array<[string, string]>]>>(DOC_PERMISSIONS_FILE)
  if (Array.isArray(persistedPerms)) {
    for (const [docId, entries] of persistedPerms) {
      if (!Array.isArray(entries)) continue
      const inner = new Map<string, string>()
      for (const [userId, perm] of entries) {
        if (typeof userId === 'string' && typeof perm === 'string') {
          inner.set(userId, perm)
        }
      }
      DOC_PERMISSIONS.set(docId, inner)
    }
  }

  // DOC_VERSIONS
  const persistedVersions = safeReadJson<Array<[string, PersistedVersionHistory]>>(DOC_VERSIONS_FILE)
  if (Array.isArray(persistedVersions)) {
    for (const [docId, history] of persistedVersions) {
      if (!history || typeof history !== 'object') continue
      DOC_VERSIONS.set(docId, {
        docId: history.docId ?? docId,
        versions: Array.isArray(history.versions) ? history.versions : [],
      })
    }
  }

  // DOC_COMMENTS
  const persistedComments = safeReadJson<Array<[string, unknown]>>(DOC_COMMENTS_FILE)
  if (Array.isArray(persistedComments)) {
    for (const [docId, comments] of persistedComments) {
      if (!Array.isArray(comments)) continue
      DOC_COMMENTS.set(docId, comments as never)
    }
  }

  // TEMPLATES
  const persistedTemplates = safeReadJson<Array<[string, unknown]>>(TEMPLATES_FILE)
  if (Array.isArray(persistedTemplates)) {
    for (const [id, tpl] of persistedTemplates) {
      if (tpl && typeof tpl === 'object' && typeof (tpl as { id?: unknown }).id === 'string') {
        TEMPLATES.set(id, tpl as never)
      }
    }
  }
}

/**
 * Test-only: wipe all six in-memory Maps + on-disk files. Mirrors the
 * `_reset*ForTests` convention used elsewhere in `common/state.ts`.
 */
export function _resetCollabStoreForTests(): void {
  COLLAB_SESSIONS.clear()
  PRESENCE.clear()
  DOC_PERMISSIONS.clear()
  DOC_VERSIONS.clear()
  DOC_COMMENTS.clear()
  TEMPLATES.clear()
  for (const path of [
    COLLAB_SESSIONS_FILE,
    PRESENCE_FILE,
    DOC_PERMISSIONS_FILE,
    DOC_VERSIONS_FILE,
    DOC_COMMENTS_FILE,
    TEMPLATES_FILE,
  ]) {
    try {
      const { unlinkSync } = require('node:fs') as typeof import('node:fs')
      if (existsSync(path)) unlinkSync(path)
    } catch {}
  }
}