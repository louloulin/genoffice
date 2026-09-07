import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBlankXlsx, hasXlsxSidecar, xlsxSidecarPath } from './helpers.js'
import { XlsxSidecarBackend } from '../src/index.js'

describe.skipIf(!hasXlsxSidecar())('XlsxSidecarBackend real process', () => {
  it('opens and reads a real workbook through the built Rust sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-sidecar-http-'))
    const backend = new XlsxSidecarBackend(xlsxSidecarPath())
    try {
      const path = join(root, 'book.xlsx')
      await createBlankXlsx(path)
      const opened = await backend.open(path)
      expect(opened).toBeTruthy()
      await backend.close((opened as { sessionId: string }).sessionId)
    } finally {
      backend.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
