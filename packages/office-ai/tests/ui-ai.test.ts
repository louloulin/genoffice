import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { startUiHost, type StartUiHostOptions, type UiHostHandle } from '../src/ui/host'
import { attachUi } from '../src/ui/host'
import { aiConfigProblem, redactAiSettings, resolveAiHostSettings } from '../src/ui/ai-settings'

const RENDERER_ROOT = fileURLToPath(new URL('../../../apps', import.meta.url))
const TOKEN = 'ai-test-token'

let host: UiHostHandle | null = null
let mock: Server | null = null
let mockBaseUrl = ''

/**
 * An OpenAI-compatible endpoint that needs no credentials, so the stream path
 * can be exercised end to end without a real provider key. `custom` resolves to
 * the openai-compatible protocol against this base URL.
 */
async function startMockProvider(chunks: string[]): Promise<string> {
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      for (const chunk of chunks) response.write(`data: ${chunk}\n\n`)
      response.write('data: [DONE]\n\n')
      response.end()
    })
    void body
  })
  mock = server
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  mockBaseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  return mockBaseUrl
}

async function bootHost(options: StartUiHostOptions = {}): Promise<UiHostHandle> {
  // The AI route is host-level plumbing; the asset resolver still wants a real
  // root, so point it at the built renderers rather than copying 60MB.
  const root = mkdtempSync(join(tmpdir(), 'office-ai-ai-'))
  for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
    symlinkSync(join(RENDERER_ROOT, app, 'out', 'renderer'), join(root, app), 'dir')
  }
  host = await startUiHost({ assetsDir: root, ...options })
  return host
}

/** Read an SSE response into its parsed `data:` frames. */
async function readFrames(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)) as Record<string, unknown>)
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${host!.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

beforeEach(async () => {
  mockBaseUrl = await startMockProvider([
    JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }),
    JSON.stringify({ choices: [{ delta: { content: ' world' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
  ])
})

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
  if (mock) {
    await new Promise<void>((r) => mock!.close(() => r()))
    mock = null
  }
})

describe('ai config resolution', () => {
  it('fills the provider catalog and reports an unconfigured host as unusable', () => {
    const blank = resolveAiHostSettings(undefined)
    expect(Object.keys(blank.providers).length).toBeGreaterThan(10)
    // The default provider is genspark, which ships a model with an empty key.
    // Without this guard the request would leave the process for a public
    // endpoint and come back as an opaque 403 instead of a local explanation.
    expect(aiConfigProblem(blank)).toMatch(/needs a GenOffice desktop login/)

    const ready = resolveAiHostSettings({ provider: 'custom', model: 'm', apiKey: 'k', baseUrl: mockBaseUrl })
    expect(ready.provider).toBe('custom')
    expect(ready.providers.custom).toMatchObject({ apiKey: 'k', model: 'm', baseUrl: mockBaseUrl })
    expect(aiConfigProblem(ready)).toBeNull()
    // The office-ai host has no gsk backend; leaving the gate on would advertise
    // tools every request then fails to service.
    expect(ready.gskToolsEnabled).toBe(false)
  })

  it('names the missing piece for each incomplete config', () => {
    expect(aiConfigProblem(resolveAiHostSettings({ provider: 'custom', model: 'm', apiKey: '' }))).toMatch(
      /No API key configured for AI provider "custom"/,
    )
    expect(aiConfigProblem(resolveAiHostSettings({ provider: 'custom', model: 'm', apiKey: 'k' }))).toMatch(
      /needs a `baseUrl`/,
    )
    // An empty model is not a misconfiguration: it falls back to the provider's
    // default rather than failing the turn.
    const defaulted = resolveAiHostSettings({ provider: 'anthropic', model: '', apiKey: 'k' })
    expect(defaulted.providers.anthropic!.model).not.toBe('')
    expect(aiConfigProblem(defaulted)).toBeNull()
  })

  it('blanks every apiKey in the browser-facing view', () => {
    const view = redactAiSettings(
      resolveAiHostSettings({ provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-real-secret' }),
    )
    expect(view.provider).toBe('anthropic')
    expect(view.providers.anthropic).toMatchObject({ model: 'claude-sonnet-5', apiKey: '' })
    expect(JSON.stringify(view)).not.toContain('sk-real-secret')
    expect(Object.values(view.providers).every((p) => p.apiKey === '')).toBe(true)
  })
})

describe('POST /api/ai/stream', () => {
  it('answers an unconfigured host with a readable error frame, never a 404', async () => {
    await bootHost()
    const response = await post('/api/ai/stream', { requestId: 'r-1', messages: [] })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const frames = await readFrames(response)
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ type: 'error', requestId: 'r-1' })
    expect(String(frames[0]!.error)).toMatch(/needs a GenOffice desktop login/)
  })

  it('streams delta frames then done, echoing requestId on every frame', async () => {
    await bootHost({ ai: { provider: 'custom', model: 'mock-model', apiKey: 'test-key', baseUrl: mockBaseUrl } })
    const response = await post('/api/ai/stream', {
      requestId: 'r-42',
      system: 'be brief',
      messages: [{ role: 'user', text: 'hi' }],
      tools: [],
      maxTokens: 256,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(response.headers.get('x-request-id')).toBe('r-42')

    const frames = await readFrames(response)
    // Every frame must carry the caller's id: createWebTransport drops any frame
    // that does not match, which the panel reads as "the model said nothing".
    expect(frames.every((f) => f.requestId === 'r-42')).toBe(true)
    const deltas = frames.filter((f) => f.type === 'delta').map((f) => f.text)
    expect(deltas.join('')).toBe('Hello world')
    expect(frames.at(-1)).toMatchObject({ type: 'done' })
  })

  it('uses the host key, not one from the request body', async () => {
    await bootHost({ ai: { provider: 'custom', model: 'mock-model', apiKey: 'host-key', baseUrl: mockBaseUrl } })
    // A renderer-supplied settings object is ignored outright — the web
    // transport never sends one, and honouring it would let any page holding a
    // host token redirect the host's credentials at an endpoint it chooses.
    const response = await post('/api/ai/stream', {
      requestId: 'r-43',
      messages: [{ role: 'user', text: 'hi' }],
      settings: { provider: 'anthropic', providers: { anthropic: { apiKey: 'attacker-key', model: 'x' } } },
    })
    expect(response.status).toBe(200)
    expect((await readFrames(response)).filter((f) => f.type === 'delta').length).toBe(2)
  })

  it('reports an upstream failure as an error frame rather than a bare 500', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(401, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const badUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    try {
      await bootHost({ ai: { provider: 'custom', model: 'mock-model', apiKey: 'bad', baseUrl: badUrl } })
      const response = await post('/api/ai/stream', { requestId: 'r-44', messages: [] })
      // Headers are already flushed by the time the provider answers, so the
      // only correct exit is an in-band error frame.
      expect(response.status).toBe(200)
      const frames = await readFrames(response)
      expect(frames.at(-1)).toMatchObject({ type: 'error', requestId: 'r-44' })
      expect(String(frames.at(-1)!.error)).toMatch(/401/)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('rejects a malformed body before the stream opens', async () => {
    await bootHost({ ai: { provider: 'custom', model: 'm', apiKey: 'k', baseUrl: mockBaseUrl } })
    const response = await fetch(`${host!.url}/api/ai/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
  })

  it('requires POST', async () => {
    await bootHost()
    const response = await fetch(`${host!.url}/api/ai/stream`)
    expect(response.status).toBe(405)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')
  })

  it('sits behind the same token gate as the rest of /api/**', async () => {
    await bootHost({ token: TOKEN, ai: { provider: 'custom', model: 'm', apiKey: 'k', baseUrl: mockBaseUrl } })
    const denied = await post('/api/ai/stream', { requestId: 'x', messages: [] })
    expect(denied.status).toBe(401)
    const allowed = await post('/api/ai/stream', { requestId: 'x', messages: [] }, { authorization: `Bearer ${TOKEN}` })
    expect(allowed.status).toBe(200)
  })

  it('is reachable under a basePath prefix', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-ai-ai-prefix-'))
    for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
      symlinkSync(join(RENDERER_ROOT, app, 'out', 'renderer'), join(root, app), 'dir')
    }
    const server = createServer((_request, response) => {
      response.writeHead(404).end('host app')
    })
    attachUi(server, {
      basePath: '/office',
      assetsDir: root,
      ai: { provider: 'custom', model: 'mock-model', apiKey: 'k', baseUrl: mockBaseUrl },
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/office/api/ai/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'p-1', messages: [] }),
      })
      expect(response.status).toBe(200)
      const frames = await readFrames(response)
      expect(frames.every((f) => f.requestId === 'p-1')).toBe(true)
      // An unprefixed request must fall through to the host app, not be served.
      expect((await fetch(`http://127.0.0.1:${port}/api/ai/stream`, { method: 'POST' })).status).toBe(404)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('ai:get-settings', () => {
  it('reports the host provider and model with no key material', async () => {
    await bootHost({ ai: { provider: 'custom', model: 'mock-model', apiKey: 'sk-do-not-leak', baseUrl: mockBaseUrl } })
    const response = await fetch(`${host!.url}/api/ipc/ai%3Aget-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    const body = (await response.json()) as { ok: boolean; result: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.result.provider).toBe('custom')
    const providers = body.result.providers as Record<string, { model: string; apiKey: string }>
    expect(providers.custom.model).toBe('mock-model')
    expect(providers.custom.apiKey).toBe('')
    expect(JSON.stringify(body)).not.toContain('sk-do-not-leak')
  })

  it('still answers on an unconfigured host so the renderer boots', async () => {
    await bootHost()
    const response = await fetch(`${host!.url}/api/ipc/ai%3Aget-settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    const body = (await response.json()) as { ok: boolean; result: { providers: Record<string, unknown> } }
    expect(body.ok).toBe(true)
    // An empty provider map crashed the settings UI; the catalog must be whole.
    expect(Object.keys(body.result.providers).length).toBeGreaterThan(10)
  })
})
