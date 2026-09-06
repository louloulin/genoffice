import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createBlankXlsx } from './helpers.js'
import { XlsxSidecarBackend } from '../src/index.js'

describe('XlsxSidecarBackend real process', () => {
  it('opens and reads a real workbook through the built Rust sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-sidecar-http-'))
    const backend = new XlsxSidecarBackend(
      join(
        dirname(new URL(import.meta.url).pathname),
        '../../../apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar',
      ),
    )
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
