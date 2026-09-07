/**
 * enterprise/update — Update-channel parity handlers.
 */

import { registerHandle } from '../common/registry.js'

export function registerUpdateHandlers(): void {
  registerHandle('update:get-state', () => ({
    status: 'idle',
    version: '1.0.0',
  }))

  registerHandle('update:download', () => ({ ok: true, status: 'downloading' }))
  registerHandle('update:install', () => ({ ok: true, status: 'installing' }))
  registerHandle('update:later', () => ({ ok: true }))
  registerHandle('update:open-download', () => ({ ok: true }))
}
