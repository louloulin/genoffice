/**
 * enterprise/tenant — Tenant management.
 */

import { registerHandle } from '../common/registry.js'
import { TENANTS } from './state.js'

export function registerTenantHandlers(): void {
  registerHandle('tenant:list', () => {
    return [...TENANTS.values()].map(t => ({
      id: t.id,
      name: t.name,
      domain: t.domain,
      plan: t.plan,
      status: t.status,
    }))
  })

  registerHandle('tenant:create', (_event: unknown, args: unknown) => {
    const { name, domain, plan } = (args || {}) as {
      name: string
      domain: string
      plan?: 'free' | 'pro' | 'enterprise'
    }
    const id = `tenant-${Date.now()}`
    TENANTS.set(id, {
      id,
      name,
      domain,
      plan: plan || 'free',
      settings: {},
      createdAt: Date.now(),
      status: 'trial',
    })
    return { ok: true, id }
  })

  registerHandle('tenant:get', (_event: unknown, args: unknown) => {
    const { id } = (args || {}) as { id: string }
    return TENANTS.get(id) || null
  })

  registerHandle('tenant:update', (_event: unknown, args: unknown) => {
    const { id, name, plan, settings, status } = (args || {}) as {
      id: string
      name?: string
      plan?: 'free' | 'pro' | 'enterprise'
      settings?: Record<string, unknown>
      status?: 'active' | 'suspended' | 'trial'
    }
    const tenant = TENANTS.get(id)
    if (!tenant) return { ok: false, error: 'Tenant not found' }
    if (name) tenant.name = name
    if (plan) tenant.plan = plan
    if (settings) tenant.settings = { ...tenant.settings, ...settings }
    if (status) tenant.status = status
    return { ok: true }
  })
}
