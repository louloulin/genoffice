/**
 * app/* — top-level application identity channels.
 */

import { registerHandle } from '../common/registry.js'

export function registerAppHandlers(): void {
  registerHandle('app:get-language', () => 'zh-CN')
  registerHandle('app:get-version', () => '0.8.0')
  registerHandle('app:get-platform', () => 'web')
  registerHandle('app:get-theme', () => ({ theme: 'system', darkMode: false, highContrast: false }))
}
