import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebComposition } from '../src/main.js'

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return { status: response.status, body: (await response.json()) as { result?: any } }
}

describe('Workbook HTTP API', () => {
  it('writes, reads, opens, ranges, and closes through the standalone server', async () => {
    const data = await mkdtemp(join(tmpdir(), 'genoffice-workbook-http-'))
    try {
      const path = join(data, 'book.xlsx')
      const backend = {
        open: async () => ({ sessionId: 's1' }),
        readRange: async () => ({ values: [['A1']] }),
        close: async () => {},
      }
      const app = await createWebComposition({ port: 0, dataDir: data, workbookBackend: backend })
      expect(
        (await call(app.server.port, 'workbook:write-file', [path, Uint8Array.from([1, 2])]))
          .status,
      ).toBe(200)
      expect((await call(app.server.port, 'workbook:read-file', [path])).status).toBe(200)
      expect((await call(app.server.port, 'workbook:open', [path])).body.result.sessionId).toBe(
        's1',
      )
      expect(
        (await call(app.server.port, 'workbook:read-range', [{ sessionId: 's1' }])).body.result
          .values[0][0],
      ).toBe('A1')
      expect((await call(app.server.port, 'workbook:close', ['s1'])).status).toBe(200)
      await app.server.close()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })
})
