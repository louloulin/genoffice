import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createWebComposition } from '../src/main.js'

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return { status: response.status, body: (await response.json()) as { result?: any } }
}

describe('Docs HTTP API', () => {
  it('round-trips a DOCX through the standalone server', async () => {
    const data = await mkdtemp(join(tmpdir(), 'genoffice-docs-http-'))
    try {
      const source = join(data, 'source.docx')
      const target = join(data, 'target.docx')
      await (await import('node:fs/promises')).writeFile(source, await buildBlankDocx())
      const app = await createWebComposition({ port: 0, dataDir: data })
      const result = await call(app.server.port, 'docs:round-trip', [source, target])
      expect(result.status).toBe(200)
      expect(result.body.result.blockCount).toBeGreaterThan(0)
      expect((await readFile(target)).length).toBeGreaterThan(0)
      await app.server.close()
    } finally {
      await rm(data, { recursive: true, force: true })
    }
  })
})
