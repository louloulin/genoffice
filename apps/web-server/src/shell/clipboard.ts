/**
 * shell/clipboard — Browser-native clipboard parity channels.
 *
 * The web-server cannot drive the OS clipboard, so handlers return messages
 * instructing the renderer to fall back to the browser's native shortcuts.
 */

import { registerHandle } from '../common/registry.js'

export function registerClipboardHandlers(): void {
  registerHandle('copy', (_event: unknown, text: unknown) => ({
    ok: true,
    message: '请使用浏览器原生 Ctrl+C / Cmd+C',
  }))
  registerHandle('cut', (_event: unknown, text: unknown) => ({
    ok: true,
    message: '请使用浏览器原生 Ctrl+X / Cmd+X',
  }))
  registerHandle('paste', () => ({
    text: '',
    message: '请使用浏览器原生 Ctrl+V / Cmd+V',
  }))

  registerHandle('clipboard:copy', (_event: unknown, text: unknown) => ({
    ok: true,
    message: '请使用浏览器原生 Ctrl+C / Cmd+C',
  }))
  registerHandle('clipboard:cut', (_event: unknown, text: unknown) => ({
    ok: true,
    message: '请使用浏览器原生 Ctrl+X / Cmd+X',
  }))
  registerHandle('clipboard:paste', () => ({
    text: '',
    message: '请使用浏览器原生 Ctrl+V / Cmd+V',
  }))
}
