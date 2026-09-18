/**
 * Translation memory survives a restart on the web build.
 *
 * The translate-skill tools used to write into the package-level in-memory
 * `sharedMemory`, while the UI's `ai:save-translation-memory` wrote into the
 * server's file-backed `PersistentTranslationMemory`. The two never met, so:
 *
 *   - a translation the agent produced was not a cache hit for the UI;
 *   - nothing the server translated survived a restart.
 *
 * The session now injects the persistent memory into the translate tools, and
 * the translate handlers flush after each call (a `save()` only marks the
 * language pair dirty). This suite restarts the server and asserts the second
 * process still answers from memory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
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

function startFakeProvider(): Promise<{ server: Server; port: number; calls: () => number }> {
  let calls = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        calls += 1
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> }
          const user = parsed.messages?.[1]?.content ?? ''
          const source = /<source_text>\n([\s\S]*?)\n<\/source_text>/.exec(user)?.[1] ?? ''
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: source } }] }))
        } catch {
          res.writeHead(500).end('{}')
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, calls: () => calls })
    })
  })
}

async function translateHttp(base: string, source: string): Promise<{ status?: string; translatedText?: string }> {
  const res = await fetch(`${base}/api/ai/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceLanguage: 'en-US',
      targetLanguage: 'zh-CN',
      units: [{ unitId: 'http-1', kind: 'paragraph', sourceText: source, order: 0 }],
    }),
  })
  const json = (await res.json()) as { ok: boolean; units?: Array<{ status?: string; translatedText?: string }> }
  return json.units?.[0] ?? {}
}

const SOURCE = 'persistent memory probe sentence'
const HTTP_SOURCE = 'http surface memory probe sentence'

describe('translation memory persistence', () => {
  let fake: Awaited<ReturnType<typeof startFakeProvider>>
  let dataDir: string
  let port: number
  let base: string

  async function boot(): Promise<ChildProcess> {
    const bundle = join(__dirname, '..', 'dist', 'bundle', 'index.js')
    const child = spawn(process.execPath, [bundle], {
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
    child.stdout?.on('data', () => {})
    child.stderr?.on('data', () => {})
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
    return child
  }

  async function stop(child: ChildProcess | undefined): Promise<void> {
    if (!child) return
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 400))
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-tm-persist-'))
    fake = await startFakeProvider()
    port = 24500 + Math.floor(Math.random() * 3000)
    base = `http://127.0.0.1:${port}`
  }, 60_000)

  afterAll(async () => {
    fake?.server.close()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('serves a translation from memory after the server restarts', async () => {
    let server = await boot()
    try {
      const first = await ipc<{ ok: boolean; units: Array<{ status?: string }> }>(
        base,
        'ai:translate-batch',
        [{ targetLang: 'zh-CN', sourceLang: 'en-US', units: [{ unitId: 'a', sourceText: SOURCE, order: 0 }] }],
      )
      expect(first.result.ok).toBe(true)
      expect(first.result.units[0]?.status).toBe('translated')
    } finally {
      await stop(server)
    }

    // The save only marked the pair dirty; the handler's flush is what puts it
    // on disk. Without that flush this directory stays empty.
    const memoryDir = join(dataDir, 'translation-memory')
    const written = (() => {
      try {
        return readdirSync(memoryDir)
      } catch {
        return [] as string[]
      }
    })()
    expect(written.length).toBeGreaterThan(0)

    const callsBeforeRestart = fake.calls()
    server = await boot()
    try {
      const second = await ipc<{ ok: boolean; units: Array<{ status?: string; translatedText?: string }> }>(
        base,
        'ai:translate-batch',
        [{ targetLang: 'zh-CN', sourceLang: 'en-US', units: [{ unitId: 'b', sourceText: SOURCE, order: 1 }] }],
      )
      expect(second.result.ok).toBe(true)
      // A memory hit proves the second process read what the first wrote.
      expect(second.result.units[0]?.status).toBe('memory-hit')
      // And it proves the provider was not consulted again.
      expect(fake.calls()).toBe(callsBeforeRestart)
    } finally {
      await stop(server)
    }
  }, 90_000)

  it('persists translations made over the HTTP endpoint without a shutdown', async () => {
    const server = await boot()
    try {
      const first = await translateHttp(base, HTTP_SOURCE)
      expect(first.status).toBe('translated')

      // Wait for the debounced write while the process is still alive. The
      // HTTP handlers share `translationMemory` with IPC, so they hit the same
      // "save() only marks the pair dirty" rule: before this schedule was
      // wired in, a running server kept the entry in memory and the file only
      // appeared because SIGTERM flushes.
      const memoryDir = join(dataDir, 'translation-memory')
      const deadline = Date.now() + 5_000
      let files: string[] = []
      while (Date.now() < deadline) {
        try {
          files = readdirSync(memoryDir)
        } catch {
          files = []
        }
        if (files.length > 0) break
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(files.length).toBeGreaterThan(0)
    } finally {
      await stop(server)
    }

    const callsBeforeRestart = fake.calls()
    const second = await boot()
    try {
      const replay = await translateHttp(base, HTTP_SOURCE)
      expect(replay.status).toBe('memory-hit')
      expect(fake.calls()).toBe(callsBeforeRestart)
    } finally {
      await stop(second)
    }
  }, 90_000)
})
