/**
 * enterprise/permissions — Doc-level permissions (string[] form, distinct from
 * collab/permissions which uses single permission strings).
 */

import { registerHandle } from '../common/registry.js'
import { PERMISSIONS } from './state.js'

export function registerPermissionsHandlers(): void {
  registerHandle('permissions:get', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    const docPerms = PERMISSIONS.get(docId)
    if (!docPerms) return []

    return [...docPerms.entries()].map(([userId, perms]) => ({
      userId,
      permissions: perms,
    }))
  })

  registerHandle('permissions:grant', (_event: unknown, args: unknown) => {
    const { docId, userId, permissions } = args as { docId: string; userId: string; permissions: string[] }

    if (!PERMISSIONS.has(docId)) {
      PERMISSIONS.set(docId, new Map())
    }

    PERMISSIONS.get(docId)!.set(userId, permissions)
    return { ok: true }
  })

  registerHandle('permissions:revoke', (_event: unknown, args: unknown) => {
    const { docId, userId } = args as { docId: string; userId: string }
    const docPerms = PERMISSIONS.get(docId)
    if (docPerms) {
      docPerms.delete(userId)
    }
    return { ok: true }
  })

  registerHandle('permissions:check', (_event: unknown, args: unknown) => {
    const { docId, userId, permission } = args as { docId: string; userId: string; permission: string }

    const docPerms = PERMISSIONS.get(docId)
    if (!docPerms) return { allowed: false, reason: 'No permissions set' }

    const userPerms = docPerms.get(userId)
    if (!userPerms) return { allowed: false, reason: 'User not found' }

    const hasPermission = userPerms.includes(permission) || userPerms.includes('*')
    return { allowed: hasPermission, reason: hasPermission ? 'OK' : 'Permission denied' }
  })
}
