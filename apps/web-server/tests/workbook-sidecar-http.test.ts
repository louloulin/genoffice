import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createBlankXlsx,
  hasXlsxSidecar,
  xlsxSidecarPath,
} from '../../../packages/workbook-service/tests/helpers.js'
import { createWebComposition } from '../src/main.js'

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  })
  return {
    status: response.status,
    body: (await response.json()) as { result?: any; error?: { message?: string } },
  }
}

describe.skipIf(!hasXlsxSidecar())('real Workbook HTTP sidecar', () => {
  it('opens a workbook through standalone HTTP and the Rust sidecar', async () => {
    const data = await mkdtemp(join(tmpdir(), 'genoffice-real-workbook-http-'))
    const sidecar = xlsxSidecarPath()
    try {
      const path = join(data, 'book.xlsx')
      await createBlankXlsx(path)
      const app = await createWebComposition({ port: 0, dataDir: data, xlsxSidecarPath: sidecar })
      const opened = await call(app.server.port, 'workbook:open', [path])
      expect(opened.status).toBe(200)
      expect(opened.body.result.sessionId).toBeTruthy()
      expect(
        (await call(app.server.port, 'workbook:close', [opened.body.result.sessionId])).status,
      ).toBe(200)
      await app.server.close()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })
})
