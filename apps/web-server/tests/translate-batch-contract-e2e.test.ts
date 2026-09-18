/**
 * Unit contract of `ai:translate-batch` on the standalone web build.
 *
 * The docs renderer drives document translation through
 * `web-bridge.ts#aiTranslateBatch`, which (outside an embedded Dataflare
 * session) forwards to the `ai:translate-batch` IPC handler. The renderer then
 * filters the returned units on `status === 'translated' || 'memory-hit'`
 * before deciding the pass produced anything, and renders `quality` next to
 * the document.
 *
 * The handler used to return only `{ ok, unitId, translatedText, matchedTerms,
 * warnings, errorMessage }`: no `status`, no `sourceText`, no `range`, and no
 * `quality`. A fully successful document translation was therefore reported as
 * "Document translation returned no usable units" — the work was done and then
 * thrown away by the consumer's own filter.
 *
 * This suite pins the wire shape the renderer and the Dataflare bridge both
 * read, plus the bounded-concurrency behaviour that keeps a 500-segment
 * document from opening 500 simultaneous provider requests.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface IpcResult<T = unknown> {
  ok: boolean
  result: T
}

async function ipc<T = unknown>(base: string, channel: string, args: unknown[] = []): Promise<IpcResult<T>> {
  const res = await fetch(`${base}/api/ipc/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return (await res.json()) as IpcResult<T>
}

async function waitForHealth(base: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(() => r(), 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

/** Echoes the source back and records how many provider calls overlap. */
function startFakeProvider(): Promise<{
  server: Server
  port: number
  peakInFlight: () => number
}> {
  let inFlight = 0
  let peak = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> }
          const user = parsed.messages?.[1]?.content ?? ''
          const source = /<source_text>\n([\s\S]*?)\n<\/source_text>/.exec(user)?.[1] ?? ''
          setTimeout(() => {
            inFlight -= 1
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: source } }] }))
          }, 25)
        } catch {
          inFlight -= 1
          res.writeHead(500).end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        peakInFlight: () => peak,
      })
    })
  })
}

describe('ai:translate-batch unit contract', () => {
  let server: ChildProcess | undefined
  let fake: Awaited<ReturnType<typeof startFakeProvider>>
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-batch-contract-'))
    fake = await startFakeProvider()
    const port = 26000 + Math.floor(Math.random() * 3000)
    base = `http://127.0.0.1:${port}`
    const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
    server = spawn(process.execPath, [bundle], {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        GENOFFICE_WEB_DATA_DIR: dataDir,
        GENOFFICE_TRANSLATION_KB: join(dataDir, 'translation-kb.json'),
        NO_OPEN: '1',
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
          openai: {
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            baseUrl: `http://127.0.0.1:${fake.port}`,
          },
        },
      },
    ])
  }, 90_000)

  afterAll(() => {
    server?.kill('SIGTERM')
    fake?.server.close()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('returns the status / sourceText / range / quality the renderer filters on', async () => {
    const { result } = await ipc<{
      ok: boolean
      units: Array<{
        unitId: string
        sourceText: string
        translatedText: string
        status?: string
        range?: unknown
        warnings?: string[]
      }>
      quality?: { overallScore?: number }
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        memoryEnabled: false,
        units: [
          { unitId: 'u1', kind: 'paragraph', sourceText: 'waistband', order: 0, range: { from: 0, to: 9 } },
          { unitId: 'u2', kind: 'paragraph', sourceText: 'flatseam', order: 1, range: { from: 10, to: 18 } },
        ],
      },
    ])

    expect(result.ok).toBe(true)
    expect(result.units).toHaveLength(2)
    for (const unit of result.units) {
      // Regression: these three used to be missing, so the renderer's
      // `status === 'translated'` filter dropped every unit and a good
      // translation surfaced as "no usable units".
      expect(unit.status).toBe('translated')
      expect(unit.sourceText).toBeTruthy()
      expect(unit.range).toEqual(expect.objectContaining({ from: expect.any(Number) }))
      expect(unit.translatedText).toBeTruthy()
    }
    expect(result.quality?.overallScore).toBeGreaterThan(0)
  })

  it('honours qualityCheck=false end-to-end: no warnings, no score', async () => {
    // The core `translateBatch` ignored the flag while the web handler honoured
    // it for the batch-level score, so desktop and web disagreed about the same
    // request and a caller that disabled quality still got per-unit warnings.
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ unitId: string; warnings?: string[] }>
      quality?: unknown
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        memoryEnabled: false,
        qualityCheck: false,
        units: [{ unitId: 'q1', kind: 'paragraph', sourceText: 'waistband', order: 0 }],
      },
    ])
    expect(result.ok).toBe(true)
    expect(result.units[0]?.warnings).toEqual([])
    expect(result.quality).toBeUndefined()
  })

  it('keeps provider concurrency bounded for a large document', async () => {
    const units = Array.from({ length: 80 }, (_, i) => ({
      unitId: `p${i}`,
      kind: 'paragraph',
      sourceText: `segment number ${i}`,
      order: i,
    }))
    const { result } = await ipc<{ ok: boolean; units: Array<{ status?: string }> }>(
      base,
      'ai:translate-batch',
      [{ targetLang: 'zh-CN', sourceLang: 'en-US', memoryEnabled: false, units }],
    )
    expect(result.ok).toBe(true)
    expect(result.units).toHaveLength(80)
    // 80 units must not mean 80 simultaneous provider requests.
    expect(fake.peakInFlight()).toBeLessThanOrEqual(25)
  })

  it('reports an empty unit as a failed unit without failing the batch', async () => {
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ unitId: string; status?: string; errorMessage?: string }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        memoryEnabled: false,
        units: [
          { unitId: 'ok', kind: 'paragraph', sourceText: 'pocket', order: 0 },
          { unitId: 'blank', kind: 'paragraph', sourceText: '   ', order: 1 },
        ],
      },
    ])
    const blank = result.units.find((unit) => unit.unitId === 'blank')
    const ok = result.units.find((unit) => unit.unitId === 'ok')
    expect(blank?.status).toBe('failed')
    expect(blank?.errorMessage).toBeTruthy()
    expect(ok?.status).toBe('translated')
    // One unsendable unit must not sink the whole document.
    expect(result.units.filter((unit) => unit.status === 'translated')).toHaveLength(1)
  })
})
