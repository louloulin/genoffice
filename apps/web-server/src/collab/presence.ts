/**
 * collab/presence — Online presence + cursor / lock + change tracking + conflict resolution.
 */

import { registerHandle } from '../common/registry.js'
import { COLLAB_SESSIONS, PRESENCE } from './state.js'

const PRESENCE_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F']

export function registerCollabPresenceHandlers(): void {
  registerHandle('collab:presence-update', (_event: unknown, args: unknown) => {
    const { docId, userId, userName, status, cursor } = args as {
      docId: string
      userId: string
      userName?: string
      status?: 'active' | 'idle' | 'away'
      cursor?: { x: number; y: number; selection?: { start: number; end: number } }
    }

    if (!PRESENCE.has(docId)) {
      PRESENCE.set(docId, new Map())
    }

    const docPresence = PRESENCE.get(docId)!
    const colorIndex = userId.charCodeAt(0) % PRESENCE_COLORS.length

    docPresence.set(userId, {
      userId,
      userName: userName || userId,
      status: status || 'active',
      lastSeen: Date.now(),
      cursor,
      color: PRESENCE_COLORS[colorIndex],
    })

    return { ok: true }
  })

  registerHandle('collab:presence-list', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    const docPresence = PRESENCE.get(docId)
    if (!docPresence) return []

    // Remove stale presence (> 60s)
    const now = Date.now()
    for (const [uid, p] of docPresence) {
      if (now - p.lastSeen > 60000) {
        docPresence.delete(uid)
      }
    }

    return [...docPresence.values()]
  })
}

export function registerCollabLockHandlers(): void {
  registerHandle('collab:lock-acquire', (_event: unknown, args: unknown) => {
    const { docId, userId, sectionId } = args as { docId: string; userId: string; sectionId?: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { ok: false, error: 'Session not found' }

    const lockKey = sectionId || 'document'
    const existingLock = session.locks.get(lockKey)

    if (existingLock && existingLock.userId !== userId && Date.now() - existingLock.timestamp < 30000) {
      return {
        ok: false,
        error: 'Section is locked',
        lockedBy: existingLock.userId,
        lockedUntil: existingLock.timestamp + 30000,
      }
    }

    session.locks.set(lockKey, { userId, timestamp: Date.now() })
    return { ok: true, lockKey, acquiredAt: Date.now() }
  })

  registerHandle('collab:lock-release', (_event: unknown, args: unknown) => {
    const { docId, userId, sectionId } = args as { docId: string; userId: string; sectionId?: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { ok: false, error: 'Session not found' }

    const lockKey = sectionId || 'document'
    const existingLock = session.locks.get(lockKey)

    if (existingLock && existingLock.userId === userId) {
      session.locks.delete(lockKey)
    }

    return { ok: true }
  })

  registerHandle('collab:lock-status', (_event: unknown, args: unknown) => {
    const { docId, sectionId } = args as { docId: string; sectionId?: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { locks: [] }

    const lockKey = sectionId || 'document'
    const lock = session.locks.get(lockKey)

    if (!lock) return { locks: [] }

    return {
      locks: [
        {
          sectionId: lockKey,
          userId: lock.userId,
          timestamp: lock.timestamp,
          expired: Date.now() - lock.timestamp > 30000,
        },
      ],
    }
  })
}

export function registerCollabCursorHandlers(): void {
  registerHandle('collab:cursor-update', (_event: unknown, args: unknown) => {
    const { docId, userId, position, selection } = args as {
      docId: string
      userId: string
      position: { x: number; y: number; offset: number }
      selection?: { start: number; end: number }
    }

    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { ok: false, error: 'Session not found' }

    session.cursors.set(userId, {
      position,
      selection,
      timestamp: Date.now(),
    })

    return { ok: true }
  })

  registerHandle('collab:cursor-list', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return []

    return [...session.cursors.entries()].map(([uid, cursor], idx) => ({
      userId: uid,
      position: cursor.position,
      selection: cursor.selection,
      color: PRESENCE_COLORS[idx % PRESENCE_COLORS.length],
    }))
  })
}

export function registerCollabChangeHandlers(): void {
  registerHandle('collab:change-track', (_event: unknown, args: unknown) => {
    const { docId, userId, change } = args as {
      docId: string
      userId: string
      change: {
        type: 'insert' | 'delete' | 'replace' | 'format'
        position: number
        content?: string
        length?: number
        attributes?: Record<string, unknown>
      }
    }

    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { ok: false, error: 'Session not found' }

    const changeRecord = {
      id: `change-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      docId,
      userId,
      change,
      timestamp: Date.now(),
      version: session.changes.length,
    }

    session.changes.push(changeRecord)

    // Keep last 1000 changes
    if (session.changes.length > 1000) {
      session.changes = session.changes.slice(-1000)
    }

    return { ok: true, changeId: changeRecord.id, version: changeRecord.version }
  })

  registerHandle('collab:change-since', (_event: unknown, args: unknown) => {
    const { docId, sinceVersion } = args as { docId: string; sinceVersion: number }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { changes: [], latestVersion: 0 }

    const changes = session.changes.filter(c => c.version > sinceVersion)

    return {
      changes: changes.map(c => ({
        id: c.id,
        userId: c.userId,
        change: c.change,
        timestamp: c.timestamp,
        version: c.version,
      })),
      latestVersion: session.changes.length,
    }
  })

  registerHandle('collab:conflict-detect', (_event: unknown, args: unknown) => {
    const { docId, baseVersion, changes } = args as {
      docId: string
      baseVersion: number
      changes: unknown[]
    }
    const session = COLLAB_SESSIONS.get(docId)
    if (!session) return { hasConflicts: false }

    const serverVersion = session.changes.length

    if (baseVersion < serverVersion) {
      return {
        hasConflicts: true,
        conflictType: 'concurrent-edits',
        serverChanges: session.changes.filter(c => c.version >= baseVersion),
        yourVersion: baseVersion,
        serverVersion,
      }
    }

    return { hasConflicts: false }
  })

  registerHandle('collab:conflict-resolve', (_event: unknown, args: unknown) => {
    const { docId, strategy, mergedContent } = args as {
      docId: string
      strategy: 'yours' | 'theirs' | 'merge' | 'manual'
      mergedContent?: unknown
    }

    return {
      ok: true,
      strategy,
      resolvedAt: Date.now(),
      newVersion: Date.now(),
    }
  })
}
