import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWebComposition } from '../src/main.js'

describe('standalone Web static E2E boundary', () => {
  it('serves the Web renderer and HTTP API from one Node origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-static-web-'))
    try {
      await writeFile(join(root, 'index.html'), '<!doctype html><title>GenOffice Web</title>')
      const app = await createWebComposition({ port: 0, dataDir: root, staticDir: root })
      const page = await fetch(`http://127.0.0.1:${app.server.port}/`)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('GenOffice Web')
      const health = await fetch(`http://127.0.0.1:${app.server.port}/api/ipc/health`)
      expect(health.status).toBe(200)
      expect((await health.json()).ok).toBe(true)
      await app.server.close()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
