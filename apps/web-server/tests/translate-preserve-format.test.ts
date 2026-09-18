/**
 * Regression: ai:translate forwarded `preserveFormat: true` to the
 * `translate_text` pi tool as `instruction: 'preserve_format'`. The tool
 * appended that literal as `Style: preserve_format`, the model echoed it
 * back in its reply, and the UI displayed gibberish instead of a clean
 * translation. `preserveFormat` is a boolean; it must reach the tool as
 * `preserve_format`, never as `instruction`.
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

async function ipc<T = unknown>(
  base: string,
  channel: string,
  args: unknown[] = [],
): Promise<IpcResult<T>> {
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
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

/**
 * Local OpenAI-compatible stub. Captures every prompt so the test can
 * assert the renderer-supplied `preserveFormat: true` reaches the model
 * only as a behavioural flag, never as `Style: preserve_format`.
 */
function startFakeProvider(): Promise<{ server: Server; port: number; prompts: string[] }> {
  const prompts: string[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> }
          const system = parsed.messages?.[0]?.content ?? ''
          prompts.push(system)
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
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0, prompts })
    })
  })
}

describe('ai:translate does not leak preserveFormat as instruction', () => {
  let server: ChildProcess | undefined
  let fake: { server: Server; port: number; prompts: string[] }
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-preserve-fmt-'))
    fake = await startFakeProvider()
    const port = 24000 + Math.floor(Math.random() * 4000)
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
          openai: { apiKey: 'test-key', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${fake.port}` },
        },
      },
    ])
  }, 60_000)

  afterAll(() => {
    server?.kill('SIGTERM')
    fake?.server.close()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('keeps the prompt free of "preserve_format" when preserveFormat=true', async () => {
    const { result } = await ipc<{
      ok: boolean
      translated?: string
      error?: string
    }>(base, 'ai:translate', [
      {
        instruction: 'Welcome to GenOffice, the AI office platform.',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        preserveFormat: true,
      },
    ])
    expect(result.ok).toBe(true)
    // The whole point: the renderer sent preserveFormat as a boolean and
    // must not see it surface as a literal instruction.
    const prompt = fake.prompts.slice(-1)[0] ?? ''
    expect(prompt).not.toContain('Style: preserve_format')
    expect(prompt).not.toContain('preserve_format')
    // The translation the stub echoes back must not contain the leak either.
    expect(result.translated ?? '').not.toMatch(/preserve_format|样式：preserve_format|样式: preserve_format/)
  })

  it('does not append "preserve_format" when preserveFormat=false either', async () => {
    const { result } = await ipc<{
      ok: boolean
      translated?: string
      error?: string
    }>(base, 'ai:translate', [
      {
        instruction: 'Good morning, happy translating.',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        preserveFormat: false,
      },
    ])
    expect(result.ok).toBe(true)
    const prompt = fake.prompts.slice(-1)[0] ?? ''
    expect(prompt).not.toContain('preserve_format')
    expect(result.translated ?? '').not.toMatch(/preserve_format|样式：preserve_format|样式: preserve_format/)
  })
})
