/**
 * enterprise/tabs — Tab management parity channels.
 */

import { registerHandle } from '../common/registry.js'
import { TABS } from './state.js'

export function registerTabsHandlers(): void {
  registerHandle('tabs:list', () => [...TABS.values()])

  registerHandle('tabs:activate', (_event: unknown, args: unknown) => {
    const { id } = (args || {}) as { id: string }
    return { ok: true, active: id }
  })

  registerHandle('tabs:close', (_event: unknown, args: unknown) => {
    const { id } = (args || {}) as { id: string }
    TABS.delete(id)
    return { ok: true }
  })

  registerHandle('tabs:reorder', (_event: unknown, args: unknown) => {
    const { id, toIndex } = (args || {}) as { id: string; toIndex: number }
    return { ok: true }
  })

  registerHandle('tabs:show-menu', (_event: unknown, args: unknown) => {
    const { x, y } = (args || {}) as { x: number; y: number }
    return { ok: true }
  })

  registerHandle('tabs:show-new-menu', (_event: unknown, args: unknown) => {
    const { x, y } = (args || {}) as { x: number; y: number }
    return { ok: true }
  })

  registerHandle('tabs:chrome-pressed', () => ({ ok: true }))
}
