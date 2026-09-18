/**
 * Per-unit option forwarding in ai:translate-batch.
 *
 * The web-server batch handler used to fan units out through
 * `translate_text` but only forwarded `text`, `source_lang`, and
 * `target_lang` — `preserveFormat`, `memoryEnabled`, `qualityCheck`,
 * `glossaryCategory`, and `scene` were silently dropped. The desktop
 * `ai:translate-batch` handler in `docs-main.ts` passes all of those
 * to `translateBatchCore`, so a renderer that asked for `glossaryCategory:
 * 'KERRITS'` got the right KB narrowing on desktop and nothing on web.
 *
 * The underlying translate-skill `translate_text` tool used to ignore the
 * same fields too: it hard-coded `memoryEnabled: true` and `qualityCheck:
 * true` and didn't expose the rest. Both layers now honour the request.
 *
 * This suite uses a stub provider that echoes the source text back, plus
 * a scoped KB entry in the `KERRITS` glossary category, to assert the
 * batch path actually narrows the KB by `glossaryCategory` (which it
 * only does when the field reaches translate_text).
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

/** The stub mirrors whatever the prompt shows in <source_text>, so any KB
 *  term the enforcement pass leaves in the source will be visible in the
 *  answer; a forwarded glossaryCategory that narrows the KB therefore
 *  changes the prompt (and thus the answer). */
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
          const user = parsed.messages?.[1]?.content ?? ''
          prompts.push(system)
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

describe('ai:translate-batch forwards per-unit options', () => {
  let server: ChildProcess | undefined
  let fake: { server: Server; port: number; prompts: string[] }
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-batch-opts-'))
    fake = await startFakeProvider()
    const port = 23000 + Math.floor(Math.random() * 5000)
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

    // Route the active provider at the stub. The test also needs a KB entry
    // in the KERRITS category so the forwarding fix has something to match.
    await ipc(base, 'ai:set-settings', [
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'test-key', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${fake.port}` },
        },
      },
    ])
    await ipc(base, 'ai:translation-kb-upsert', [
      {
        id: 'verify-fabric-weight-kerrits',
        schema: 'term',
        sourceTerm: 'fabric weight',
        targetTerm: '克重',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        category: 'apparel',
        customerName: 'KERRITS',
        priority: 5,
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

  it('forwards glossaryCategory so the customer bucket narrows the KB', async () => {
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ unitId: string; ok: boolean; matchedTerms?: string[]; translatedText?: string }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        glossaryCategory: 'KERRITS',
        units: [{ unitId: 'k1', sourceText: 'fabric weight sample' }],
      },
    ])
    expect(result.ok).toBe(true)
    expect(result.units[0]?.matchedTerms).toContain('fabric weight')
  })

  it('omits the term when glossaryCategory is forwarded as a different bucket', async () => {
    // The same source text under a different bucket must not see the
    // KERRITS-only term; the prompt buffer is the only observation we have
    // for a forwarding regression that drops the filter.
    await ipc(base, 'ai:translation-kb-upsert', [
      {
        id: 'verify-acme-fabric-weight',
        schema: 'term',
        sourceTerm: 'fabric weight',
        targetTerm: 'fabric weight',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        category: 'apparel',
        customerName: 'ACME',
        priority: 5,
      },
    ])
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ unitId: string; ok: boolean; matchedTerms?: string[] }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        glossaryCategory: 'ACME',
        units: [{ unitId: 'a1', sourceText: 'fabric weight measurement' }],
      },
    ])
    expect(result.ok).toBe(true)
    // The KERRITS-only entry (target = 克重) must be filtered out when the
    // caller asks for the ACME bucket. We assert against the target
    // translation that lives in the prompt buffer, not against the source
    // term, because the ACME entry also uses "fabric weight" as its source.
    // Inspect the captured prompt buffers the stub recorded.
    const promptsAfter = fake.prompts.slice(-1)[0] ?? ""
    expect(promptsAfter).not.toContain("克重")
  })
})
