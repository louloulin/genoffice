/**
 * collab/* — Public entry for collaboration channels.
 *
 * Aggregates per-feature sub-modules: sessions (join/leave/sync), presence
 * (online status), permissions, change tracking + conflict, history,
 * comments, and templates.
 */

import { registerCollabSessionHandlers } from './sessions.js'
import {
  registerCollabPresenceHandlers,
  registerCollabLockHandlers,
  registerCollabCursorHandlers,
  registerCollabChangeHandlers,
} from './presence.js'
import { registerCollabPermissionsHandlers } from './permissions.js'
import { registerHistoryHandlers } from './history.js'
import { registerCommentsHandlers } from './comments.js'
import { registerTemplatesHandlers } from './templates.js'
import { snapshotCollabSessions } from './state.js'

export { snapshotCollabSessions }

export function registerCollabHandlers(): void {
  registerCollabSessionHandlers()
  registerCollabPresenceHandlers()
  registerCollabLockHandlers()
  registerCollabCursorHandlers()
  registerCollabChangeHandlers()
  registerCollabPermissionsHandlers()
  registerHistoryHandlers()
  registerCommentsHandlers()
  registerTemplatesHandlers()
}
