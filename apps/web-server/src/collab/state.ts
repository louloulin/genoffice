/**
 * collab/state — shared in-memory collaboration state.
 *
 * Exposes the maps / sets originally declared at the top of the monolith
 * so that the per-feature sub-modules can register handlers against a
 * single canonical state. Persistence lands with the Phase 2 collab-server
 * (per LUM-551 §4.4).
 */

export interface CollabSessionUser {
  userId: string
  userName: string
  status: 'active' | 'idle' | 'away'
  lastSeen: number
  cursor?: { x: number; y: number; selection?: { start: number; end: number } }
  color: string
}

export interface CollabChangeRecord {
  id: string
  docId: string
  userId: string
  change: unknown
  timestamp: number
  version: number
}

export interface CollabSession {
  docId: string
  users: Set<string>
  lastActivity: number
  locks: Map<string, { userId: string; timestamp: number }>
  cursors: Map<string, {
    position: { x: number; y: number; offset: number }
    selection?: { start: number; end: number }
    timestamp: number
  }>
  changes: CollabChangeRecord[]
}

export const COLLAB_SESSIONS = new Map<string, CollabSession>()

/** Lightweight snapshot used by GET /api/collab/sessions. */
export function snapshotCollabSessions(): Array<{ docId: string; users: string[]; lastActivity: number }> {
  return [...COLLAB_SESSIONS.entries()].map(([docId, session]) => ({
    docId,
    users: [...session.users],
    lastActivity: session.lastActivity,
  }))
}

export const PRESENCE = new Map<string, Map<string, CollabSessionUser>>()

export const DOC_PERMISSIONS = new Map<string, Map<string, string>>()

// ----------------------------------------------------------------------------
// Doc version history (history:*)
// ----------------------------------------------------------------------------

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

export const DOC_VERSIONS = new Map<string, DocVersionHistory>()

// ----------------------------------------------------------------------------
// Doc comments (comments:*)
// ----------------------------------------------------------------------------

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

export const DOC_COMMENTS = new Map<string, DocComment[]>()
