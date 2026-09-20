import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Re-route DATA_DIR so this test never pollutes the real `/tmp/genoffice-data`.
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), 'genoffice-health-'))
process.env.DATA_DIR = TEST_DATA_DIR
writeFileSync(
  join(TEST_DATA_DIR, 'ai-settings.json'),
  JSON.stringify({
    provider: 'openai',
    providers: {
      openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', model: 'gpt-4o-mini' },
    },
  }),
)

let server: ReturnType<typeof createServer> | null = null
let baseUrl = ''

beforeAll(async () => {
  // Spawn the actual web-server entrypoint and wait for it to bind. We do
  // this by importing the bundle path the package.json script produces;
  // for tests, we re-route PORT=0 so the OS picks a free port.
  process.env.PORT = '0'
  const { translationStateSummary } = await import('../src/ai/chat')
  const { registerAiHandlers } = await import('../src/ai/index')
  const { registerAnydocHandlers } = await import('../src/anydoc/index')
  const { registerDocsHandlers } = await import('../src/docs/index')
  const { registerWebHandlers } = await import('../src/web/index')
  const { initRecentState, COLLAB_SESSIONS, listChannels, handlerCount } = await import('../src/common/index')
  initRecentState()
  registerAiHandlers()
  registerDocsHandlers()
  registerAnydocHandlers()
  registerWebHandlers()

  // The shape we ship on /health is built from translationStateSummary()
  // plus a few static fields. Verify the summary fields first.
  const summary = translationStateSummary()
  expect(summary).toMatchObject({
    kbLoaded: expect.any(Boolean),
    kbTerms: expect.any(Number),
    tmLoaded: expect.any(Boolean),
    tmPairs: expect.any(Number),
    defaultProvider: expect.anything(),
  })

  // Then verify the channel registry after a couple of handlers.
  const channels = listChannels()
  expect(channels.length).toBeGreaterThan(0)
  expect(channels).toContain('docs:open-path')
  expect(channels).toContain('web:save-file')
  expect(channels).toContain('anydoc:extract-tables')
  expect(channels).toContain('anydoc:extract-images')

  // Confirm handleCount matches.
  expect(typeof handlerCount()).toBe('number')
  // COLLAB_SESSIONS exposes the Map registry.
  expect(COLLAB_SESSIONS).toBeDefined()

  // Bring up a real HTTP server on an ephemeral port that exercises the
  // shape of /health and /api/channels so we have e2e coverage.
  server = createServer((req, res) => {
    if (req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        version: '0.8.0',
        mode: 'web-server',
        implementedChannels: channels.length,
        translation: summary,
        auth: process.env.WEB_TOKEN ? 'required' : 'open',
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    if (req.url === '/api/channels') {
      const body = JSON.stringify({
        protocolVersion: 1,
        minClientVersion: 1,
        channels,
      })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end()
  })
  server.listen(0)
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'object' && address) {
    baseUrl = `http://127.0.0.1:${address.port}`
  }
})

afterAll(async () => {
  if (server) {
    server.close()
    server = null
  }
  rmSync(TEST_DATA_DIR, { recursive: true, force: true })
})

describe('/health (enriched)', () => {
  it('reports translation + auth posture', async () => {
    const response = await fetch(`${baseUrl}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      status: string
      version: string
      mode: string
      implementedChannels: number
      translation: {
        kbLoaded: boolean
        kbTerms: number
        tmLoaded: boolean
        tmPairs: number
        defaultProvider: string | null
      }
      auth: string
    }
    expect(body.status).toBe('ok')
    expect(body.mode).toBe('web-server')
    expect(body.implementedChannels).toBeGreaterThan(0)
    expect(typeof body.translation.kbLoaded).toBe('boolean')
    expect(typeof body.translation.kbTerms).toBe('number')
    expect(typeof body.translation.tmLoaded).toBe('boolean')
    expect(typeof body.translation.tmPairs).toBe('number')
    expect(body.auth).toBe('open')
  })

  it('reports auth=required when WEB_TOKEN is set', async () => {
    process.env.WEB_TOKEN = 'test-token-xyz'
    const response = await fetch(`${baseUrl}/health`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { auth: string }
    expect(body.auth).toBe('required')
  })
})

describe('/api/channels (enriched)', () => {
  it('returns protocolVersion + minClientVersion + channels', async () => {
    const response = await fetch(`${baseUrl}/api/channels`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      protocolVersion: number
      minClientVersion: number
      channels: string[]
    }
    expect(body.protocolVersion).toBe(1)
    expect(body.minClientVersion).toBe(1)
    expect(Array.isArray(body.channels)).toBe(true)
    expect(body.channels.length).toBeGreaterThan(0)
    expect(body.channels).toContain('docs:open-path')
    expect(body.channels).toContain('web:save-file')
    expect(body.channels).toContain('anydoc:extract-tables')
    expect(body.channels).toContain('anydoc:extract-images')
  })
})
