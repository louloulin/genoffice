/**
 * collab/permissions — Per-doc user permissions.
 */

import { registerHandle } from '../common/registry.js'
import { DOC_PERMISSIONS } from './state.js'

export function registerCollabPermissionsHandlers(): void {
  registerHandle('collab:permissions-get', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    const perms = DOC_PERMISSIONS.get(docId)
    if (!perms) return []

    return [...perms.entries()].map(([userId, perm]) => ({
      userId,
      permission: perm,
    }))
  })

  registerHandle('collab:permissions-set', (_event: unknown, args: unknown) => {
    const { docId, userId, permission } = args as {
      docId: string
      userId: string
      permission: 'view' | 'edit' | 'admin'
    }

    if (!DOC_PERMISSIONS.has(docId)) {
      DOC_PERMISSIONS.set(docId, new Map())
    }

    DOC_PERMISSIONS.get(docId)!.set(userId, permission)

    return { ok: true }
  })
}
