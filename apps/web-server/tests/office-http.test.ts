import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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

describe('Slides/PDF HTTP API', () => {
  it('creates, saves, reads, and inspects a PPTX', async () => {
    const data = await mkdtemp(join(tmpdir(), 'genoffice-office-http-'))
    try {
      const app = await createWebComposition({ port: 0, dataDir: data })
      const path = join(data, 'deck.pptx')
      const blank = (await call(app.server.port, 'slides:create-blank', [])).body.result
      expect((await call(app.server.port, 'slides:save-file', [path, blank])).status).toBe(200)
      expect(
        (await call(app.server.port, 'slides:inspect-file', [path])).body.result.slideCount,
      ).toBe(1)
      expect((await readFile(path)).length).toBeGreaterThan(0)
      await app.server.close()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })

  it('creates, saves, reads, and validates a PDF', async () => {
    const data = await mkdtemp(join(tmpdir(), 'genoffice-office-http-'))
    try {
      const app = await createWebComposition({ port: 0, dataDir: data })
      const path = join(data, 'blank.pdf')
      const blank = (await call(app.server.port, 'pdf:create-blank', [])).body.result
      await call(app.server.port, 'pdf:save-file', [path, blank])
      expect(
        (await call(app.server.port, 'pdf:validate-bytes', [blank])).body.result.pageCount,
      ).toBe(1)
      expect((await call(app.server.port, 'pdf:read-file', [path])).status).toBe(200)
      await app.server.close()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })
})
