import { writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { DocxFileService } from '../src/index.js'
import { describe, expect, it } from 'vitest'

describe('DocxFileService', () => {
  it('reads and validates a DOCX using the Node-safe engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-docx-service-'))
    try {
      const path = join(root, 'blank.docx')
      await writeFile(path, await buildBlankDocx())
      const service = new DocxFileService({ rootDir: root })
      const result = await service.validate(await service.read(path))
      expect(result.blockCount).toBeGreaterThan(0)
      expect((await service.parse(path)).blocks.length).toBe(result.blockCount)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects DOCX paths outside the configured root', async () => {
    const service = new DocxFileService({ rootDir: '/tmp/genoffice-docx-root' })
    await expect(service.read('/tmp/outside.docx')).rejects.toThrow('outside')
  })
})
