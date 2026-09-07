/**
 * shell/* — Public entry for browser-window + clipboard parity channels.
 */

import { registerClipboardHandlers } from './clipboard.js'
import { registerWinHandlers } from './win.js'

export function registerShellHandlers(): void {
  registerClipboardHandlers()
  registerWinHandlers()
}
