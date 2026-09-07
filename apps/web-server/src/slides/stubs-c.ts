/**
 * slides stubs (batch C): remaining placeholder handlers preserved verbatim.
 */

import { registerHandle } from '../common/registry.js'

export function registerSlidesStubsC(): void {
  registerHandle('slides:files-pick', () => ({
    canceled: false,
    filePaths: [],
    message: '请使用 Web File API',
  }))
  registerHandle('slides:pick-export-dir', () => ({ path: '/tmp/exports' }))
  registerHandle('slides:pick-export-pdf-path', () => ({ path: '/tmp/exports/presentation.pdf' }))
  registerHandle('slides:private-font-data', () => ({}))
  registerHandle('slides:private-font-faces', () => [])
  registerHandle('slides:repaste-slide', () => ({ ok: true }))
}
