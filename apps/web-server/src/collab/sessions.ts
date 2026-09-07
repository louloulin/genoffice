/**
 * collab/sessions — Join / leave / sync handlers and the underlying session map.
 */

import { registerHandle } from '../common/registry.js'
import { COLLAB_SESSIONS } from './state.js'

export function registerCollabSessionHandlers(): void {
  registerHandle('collab:join', (_event: unknown, args: unknown) => {
    const { docId, userId, userName } = args as { docId: string; userId: string; userName?: string }
    const sessionId = `${docId}:${userId}`

    if (!COLLAB_SESSIONS.has(docId)) {
      COLLAB_SESSIONS.set(docId, {
        docId,
        users: new Set(),
        lastActivity: Date.now(),
        locks: new Map(),
        cursors: new Map(),
        changes: [],
      })
    }

    const session = COLLAB_SESSIONS.get(docId)!
    session.users.add(userId)
    session.lastActivity = Date.now()

    return { sessionId, users: [...session.users], docId, userCount: session.users.size }
  })

  registerHandle('collab:leave', (_event: unknown, args: unknown) => {
    const { docId, userId } = args as { docId: string; userId: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (session) {
      session.users.delete(userId)
      if (session.users.size === 0) {
        COLLAB_SESSIONS.delete(docId)
      }
    }
    return { ok: true }
  })

  registerHandle('collab:sync', (_event: unknown, args: unknown) => {
    const { docId, changes, userId } = args as { docId: string; changes: unknown; userId: string }
    const session = COLLAB_SESSIONS.get(docId)
    if (session) {
      session.lastActivity = Date.now()
      return {
        ok: true,
        acknowledged: true,
        users: [...session.users],
        timestamp: Date.now(),
        serverTime: Date.now(),
      }
    }
    return { ok: false, error: 'Session not found' }
  })
}
