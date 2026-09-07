/**
 * enterprise/users — User management.
 */

import { registerHandle } from '../common/registry.js'
import { USERS } from './state.js'

export function registerUsersHandlers(): void {
  registerHandle('users:list', (_event: unknown) => {
    return [...USERS.values()].map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
    }))
  })

  registerHandle('users:get', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    return USERS.get(id) || null
  })

  registerHandle('users:create', (_event: unknown, args: unknown) => {
    const { name, email, role } = args as { name: string; email: string; role?: string }
    const id = `user-${Date.now()}`
    USERS.set(id, {
      id,
      name,
      email,
      role: (role as 'admin' | 'editor' | 'viewer') || 'viewer',
      createdAt: Date.now(),
    })
    return { ok: true, id }
  })

  registerHandle('users:update', (_event: unknown, args: unknown) => {
    const { id, name, email, role } = args as { id: string; name?: string; email?: string; role?: string }
    const user = USERS.get(id)
    if (!user) return { ok: false, error: 'User not found' }
    if (name) user.name = name
    if (email) user.email = email
    if (role) user.role = role as 'admin' | 'editor' | 'viewer'
    return { ok: true }
  })

  registerHandle('users:delete', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    if (!USERS.has(id)) return { ok: false, error: 'User not found' }
    USERS.delete(id)
    return { ok: true }
  })
}
