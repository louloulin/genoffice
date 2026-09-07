import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkbookFileService } from '../src/index.js'

describe('WorkbookFileService', () => {
  it('reads and writes workbook bytes without Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-workbook-service-'))
    try {
      const path = join(root, 'book.xlsx')
      const service = new WorkbookFileService({
        open: async () => ({}),
        readRange: async () => ({}),
        close: async () => {},
      })
      await service.write(path, Uint8Array.from([1, 2, 3]))
      expect(await service.read(path)).toEqual(Uint8Array.from([1, 2, 3]))
      expect(await readFile(path)).toEqual(Buffer.from([1, 2, 3]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('delegates workbook operations to an injected Node backend', async () => {
    const calls: string[] = []
    const service = new WorkbookFileService({
      open: async () => {
        calls.push('open')
        return { sessionId: 's1' }
      },
      readRange: async () => {
        calls.push('read')
        return { values: [[1]] }
      },
      close: async () => {
        calls.push('close')
      },
    })
    expect(await service.open('/tmp/book.xlsx')).toEqual({ sessionId: 's1' })
    expect(await service.readRange({})).toEqual({ values: [[1]] })
    await service.close('s1')
    expect(calls).toEqual(['open', 'read', 'close'])
  })
})
