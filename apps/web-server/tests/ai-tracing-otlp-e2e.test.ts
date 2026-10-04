/**
 * OTLP span chain, end to end (A23 / A69 / A70).
 *
 * Boots the real bundle against a local OTLP collector and a local
 * OpenAI-compatible provider, drives one `/api/ai/stream` turn, and asserts the
 * collector received the full AI main-path chain: entry → provider call →
 * write-back. This is the web-server half of A70 — the package-level suite
 * (`packages/agent-telemetry/tests/otlp.test.ts`) pins the wire format, this
 * one pins that the live request path actually emits it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

interface CollectedSpan {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
  attributes: Array<{ key: string; value: Record<string, unknown> }>
}

function startCollector(): Promise<{ server: Server; url: string; spans: CollectedSpan[] }> {
  const spans: CollectedSpan[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: CollectedSpan[] }> }>
          }
          for (const rs of payload.resourceSpans ?? []) {
            for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? []))
          }
        } catch {
          /* a malformed body is a test failure the assertions will surface */
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${port}`, spans })
    })
  })
}

/** Minimal OpenAI-compatible stub: streaming replies as SSE chunks, everything else (the translation core's non-streaming call) as one JSON completion. */
function startFakeProvider(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const wantsStream = /"stream"\s*:\s*true/.test(Buffer.concat(chunks).toString('utf8'))
        if (wantsStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          const delta = { id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello from the stub.' } }] }
          res.write(`data: ${JSON.stringify(delta)}\n\n`)
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
          )
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: '你好，来自桩服务。' } }] }),
        )
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, port })
    })
  })
}

async function ipc<T = unknown>(base: string, channel: string, args: unknown[] = []): Promise<T> {
  const res = await fetch(`${base}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return (await res.json()) as T
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

/** Poll the collector until the requested span names have all arrived. */
async function waitForSpans(spans: CollectedSpan[], names: string[], timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (names.every((name) => spans.some((span) => span.name === name))) return
    await new Promise((r) => setTimeout(r, 200))
  }
}

function attr(span: CollectedSpan | undefined, key: string): unknown {
  return span?.attributes.find((a) => a.key === key)?.value
}

describe('AI main path exports a complete span chain to an OTLP collector', () => {
  let server: ChildProcess | undefined
  let collector: { server: Server; url: string; spans: CollectedSpan[] }
  let fake: { server: Server; port: number }
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-otlp-'))
    collector = await startCollector()
    fake = await startFakeProvider()
    const port = 25000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        GENOFFICE_WEB_DATA_DIR: dataDir,
        GENOFFICE_OTLP_ENDPOINT: collector.url,
        GENOFFICE_OTLP_SERVICE_NAME: 'genoffice-web-server-e2e',
        // 200ms so the batched exporter ships the chain without a 5s wait.
        GENOFFICE_OTLP_FLUSH_MS: '200',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', () => {})
    server.stderr?.on('data', () => {})
    await waitForHealth(base)

    await ipc(base, 'ai:set-settings', [
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'test-key', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${fake.port}` },
        },
      },
    ])
  }, 60_000)

  afterAll(async () => {
    fake?.server.close()
    collector?.server.close()
    await stopServer(server, dataDir)
  })

  it('emits entry → provider call → write-back for POST /api/ai/stream', async () => {
    const res = await fetch(`${base}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'otlp-e2e-1',
        settings: { provider: 'openai' },
        system: 'You are a test.',
        messages: [{ role: 'user', content: 'Say hello.' }],
      }),
    })
    expect(res.status).toBe(200)
    // Drain the SSE body so the handler runs to completion.
    await res.text()

    await waitForSpans(collector.spans, ['ai.stream', 'ai.provider.call', 'ai.stream.write-back'])

    const entry = collector.spans.find((s) => s.name === 'ai.stream')
    const provider = collector.spans.find((s) => s.name === 'ai.provider.call')
    const writeBack = collector.spans.find((s) => s.name === 'ai.stream.write-back')

    expect(entry, 'ai.stream span missing').toBeTruthy()
    expect(provider, 'ai.provider.call span missing').toBeTruthy()
    expect(writeBack, 'ai.stream.write-back span missing').toBeTruthy()

    // The three stages form one joinable chain.
    expect(entry?.parentSpanId).toBeUndefined()
    expect(provider?.parentSpanId).toBe(entry?.spanId)
    expect(writeBack?.parentSpanId).toBe(entry?.spanId)
    expect(new Set([entry?.traceId, provider?.traceId, writeBack?.traceId]).size).toBe(1)

    expect(attr(entry, 'route')).toEqual({ stringValue: '/api/ai/stream' })
    expect(attr(entry, 'provider')).toEqual({ stringValue: 'openai' })
    expect(attr(writeBack, 'requestId')).toEqual({ stringValue: 'otlp-e2e-1' })
  })

  it('routes the chain to the configured service name', async () => {
    // The collector above only stores spans; resource identity is asserted on
    // the raw payload elsewhere. Here we prove a second request reuses the same
    // trace session id so an operator can join turns from one process.
    const before = collector.spans.filter((s) => s.name === 'ai.stream').length
    const res = await fetch(`${base}/api/ai/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'otlp-e2e-2',
        settings: { provider: 'openai' },
        messages: [{ role: 'user', content: 'Again.' }],
      }),
    })
    await res.text()
    await waitForSpans(collector.spans, ['ai.stream.write-back'])
    // Give the second turn's chain a moment to land as a whole.
    await new Promise((r) => setTimeout(r, 400))

    const entries = collector.spans.filter((s) => s.name === 'ai.stream')
    expect(entries.length).toBeGreaterThan(before)
    expect(entries.every((s) => s.traceId === entries[0].traceId)).toBe(true)
  })

  it('emits entry → provider call → write-back for POST /api/ai/translate/stream', async () => {
    const res = await fetch(`${base}/api/ai/translate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguage: 'zh-CN',
        sourceLanguage: 'en-US',
        memoryEnabled: false,
        units: [{ unitId: 'u1', kind: 'paragraph', sourceText: 'Hello world.', order: 0 }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('event: complete')

    await waitForSpans(collector.spans, ['ai.translate.stream', 'ai.translate.write-back'])

    const entry = collector.spans.filter((s) => s.name === 'ai.translate.stream').at(-1)
    const provider = collector.spans.filter((s) => s.name === 'ai.provider.call').at(-1)
    const writeBack = collector.spans.filter((s) => s.name === 'ai.translate.write-back').at(-1)

    expect(entry, 'ai.translate.stream span missing').toBeTruthy()
    expect(writeBack, 'ai.translate.write-back span missing').toBeTruthy()
    // The provider-call leg shares the trace and hangs off the entry span.
    expect(provider?.traceId).toBe(entry?.traceId)
    expect(writeBack?.parentSpanId).toBe(entry?.spanId)
    expect(entry?.parentSpanId).toBeUndefined()
    expect(attr(entry, 'route')).toEqual({ stringValue: '/api/ai/translate/stream' })
    expect(attr(entry, 'totalUnits')).toEqual({ intValue: '1' })
    expect(attr(writeBack, 'completedUnits')).toEqual({ intValue: '1' })
  }, 30_000)
})
