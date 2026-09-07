/**
 * shell/win — Browser window management stubs.
 *
 * Web-server cannot spawn real OS windows, so it tracks an in-memory list
 * of requested windows for parity with the Electron `win:*` channels.
 */

import { registerHandle } from '../common/registry.js'

const WEB_WINDOWS: Map<string, { url: string; name: string }> = new Map()

export function registerWinHandlers(): void {
  registerHandle('win:new', (_event: unknown, options: unknown) => {
    const opts = options as { url?: string; name?: string } | undefined
    const id = `win-${Date.now()}`
    WEB_WINDOWS.set(id, { url: opts?.url || '/', name: opts?.name || '新窗口' })
    return { id, url: opts?.url || '/' }
  })

  registerHandle('win:list', () => {
    return [...WEB_WINDOWS.entries()].map(([id, win]) => ({ id, ...win }))
  })

  registerHandle('win:focus', (_event: unknown, id: unknown) => {
    if (WEB_WINDOWS.has(id as string)) {
      return { ok: true, id }
    }
    return { ok: false, error: 'Window not found' }
  })
}
