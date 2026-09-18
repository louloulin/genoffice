/**
 * Cross-customer bucket isolation across every translation entry point.
 *
 * A translation KB carries per-customer terminology: the KERRITS bucket maps
 * `fabric weight -> 克重(K)`, the ACME bucket maps it to `克重(A)`, and a
 * generic unscoped entry maps it to `克重`. Three separate leaks let one
 * customer's terminology reach another customer's document:
 *
 *   1. `KnowledgeBase.resolve` returned *every* scoped term when the caller
 *      named no bucket, so an unscoped document was handed KERRITS + ACME +
 *      generic variants of the same source term at once and the model picked
 *      whichever it saw first.
 *   2. The translation memory keyed only on `sourceLang::targetLang::source`,
 *      so the first customer's translation was replayed verbatim for the next.
 *   3. The HTTP SSE handler forwarded `glossaryCategory` but dropped
 *      `customerName`, so a caller that only knew the customer name got an
 *      unscoped (i.e. every customer's) prompt.
 *
 * The stub provider echoes the KB-mandated target it was handed in the prompt,
 * which makes the resolved term set directly observable in the response: the
 * three buckets must produce three different answers for the same source text.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * The stub answers with the target half of the first KB term line found in the
 * prompt (`- "fabric weight" -> "克重(K)"`), falling back to echoing the source.
 * That makes "which terms did the resolver hand the model" directly observable
 * in the returned string.
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
          const user = parsed.messages?.[1]?.content ?? ''
          prompts.push(system)
          const source = /<source_text>\n([\s\S]*?)\n<\/source_text>/.exec(user)?.[1] ?? ''
          const term = /- "fabric weight" -> "([^"]+)"/.exec(system)?.[1]
          const answer = term ?? source
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }))
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

const SOURCE = 'fabric weight specification'

describe('cross-customer bucket isolation', () => {
  let server: ChildProcess | undefined
  let fake: { server: Server; port: number; prompts: string[] }
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-bucket-iso-'))
    fake = await startFakeProvider()
    const port = 28000 + Math.floor(Math.random() * 3000)
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

    const term = (id: string, target: string, customerName?: string) => ({
      id,
      schema: 'term',
      sourceTerm: 'fabric weight',
      targetTerm: target,
      sourceLang: 'en-US',
      targetLang: 'zh-CN',
      category: 'apparel',
      ...(customerName ? { customerName } : {}),
      priority: 5,
    })
    await ipc(base, 'ai:translation-kb-upsert', [term('iso-generic', '克重')])
    await ipc(base, 'ai:translation-kb-upsert', [term('iso-kerrits', '克重(K)', 'KERRITS')])
    await ipc(base, 'ai:translation-kb-upsert', [term('iso-acme', '克重(A)', 'ACME')])
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

  async function batch(bucket: Record<string, string>, unitId: string): Promise<string | undefined> {
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ unitId: string; translatedText?: string; status?: string }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        memoryEnabled: false,
        ...bucket,
        units: [{ unitId, sourceText: SOURCE }],
      },
    ])
    expect(result.ok).toBe(true)
    return result.units[0]?.translatedText
  }

  it('resolves a different term set per customer bucket over IPC', async () => {
    const kerrits = await batch({ glossaryCategory: 'KERRITS' }, 'k')
    const acme = await batch({ customerName: 'ACME' }, 'a')
    const generic = await batch({}, 'g')

    expect(kerrits).toBe('克重(K)')
    expect(acme).toBe('克重(A)')
    // Regression: an unscoped call used to be handed every customer's term
    // (three conflicting `fabric weight` rows in one prompt), so the answer
    // depended on model ordering rather than on the caller's intent.
    expect(generic).toBe('克重')
  })

  it('serves a term upserted after the first HTTP request', async () => {
    // The HTTP endpoints hold one long-lived `KnowledgeBase` while the UI
    // writes through the pi session's own instance — same JSON file, different
    // object. A plain boot-time load made every later HTTP translation answer
    // from that stale snapshot: verified on a live server, a term upserted
    // after the first HTTP call stayed invisible until the process restarted.
    const post = async (body: Record<string, unknown>): Promise<string | undefined> => {
      const res = await fetch(`${base}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: 'zh-CN',
          sourceLanguage: 'en-US',
          memoryEnabled: false,
          units: [{ unitId: 'fresh', kind: 'paragraph', sourceText: SOURCE, order: 0 }],
          ...body,
        }),
      })
      const json = (await res.json()) as { units?: Array<{ translatedText?: string }> }
      return json.units?.[0]?.translatedText
    }

    // Warm the HTTP path first, so its KB instance has a loaded store.
    expect(await post({})).toBe('克重')

    await ipc(base, 'ai:translation-kb-upsert', [
      {
        id: 'iso-late',
        schema: 'term',
        sourceTerm: 'fabric weight',
        targetTerm: '克重(LATE)',
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        category: 'apparel',
        customerName: 'LATECOMER',
        priority: 5,
      },
    ])

    expect(await post({ customerName: 'LATECOMER' })).toBe('克重(LATE)')
  })

  it('applies language-scoped KB terms when the caller auto-detects the source', async () => {
    // The renderer's source picker defaults to auto-detect. A term that names
    // its source language used to be filtered out by the exact-equality
    // language check, so the KB the user curated never applied on the default
    // path — neither to a snippet, a file, nor the dictionary builder.
    const { result } = await ipc<{
      ok: boolean
      units: Array<{ translatedText?: string; status?: string }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'auto',
        memoryEnabled: false,
        glossaryCategory: 'KERRITS',
        units: [{ unitId: 'auto', sourceText: SOURCE }],
      },
    ])
    expect(result.ok).toBe(true)
    expect(result.units[0]?.translatedText).toBe('克重(K)')
  })

  it('narrows the same way when the bucket only arrives as customerName', async () => {
    const viaName = await batch({ customerName: 'KERRITS' }, 'k2')
    expect(viaName).toBe('克重(K)')
  })

  it('carries the bucket through the HTTP batch endpoint', async () => {
    const post = async (body: Record<string, unknown>): Promise<string | undefined> => {
      const res = await fetch(`${base}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: 'zh-CN',
          sourceLanguage: 'en-US',
          memoryEnabled: false,
          units: [{ unitId: 'u', kind: 'paragraph', sourceText: SOURCE, order: 0 }],
          ...body,
        }),
      })
      const json = (await res.json()) as {
        ok: boolean
        units?: Array<{ translatedText?: string }>
      }
      expect(json.ok).toBe(true)
      return json.units?.[0]?.translatedText
    }

    expect(await post({ glossaryCategory: 'KERRITS' })).toBe('克重(K)')
    expect(await post({ customerName: 'ACME' })).toBe('克重(A)')
    expect(await post({})).toBe('克重')
  })

  it('carries customerName through the SSE stream endpoint', async () => {
    const stream = async (body: Record<string, unknown>): Promise<string[]> => {
      const res = await fetch(`${base}/api/ai/translate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: 'zh-CN',
          sourceLanguage: 'en-US',
          memoryEnabled: false,
          units: [{ unitId: 's', kind: 'paragraph', sourceText: SOURCE, order: 0 }],
          ...body,
        }),
      })
      const text = await res.text()
      const answers: string[] = []
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const payload = JSON.parse(line.slice(6)) as {
          type?: string
          unit?: { translatedText?: string; matchedTerms?: string[] }
        }
        if (payload.type === 'unit' && payload.unit?.translatedText) {
          answers.push(payload.unit.translatedText)
        }
      }
      return answers
    }

    // Regression: the stream handler forwarded `glossaryCategory` but dropped
    // `customerName`, so this call ran unscoped.
    expect(await stream({ customerName: 'ACME' })).toEqual(['克重(A)'])
    expect(await stream({ glossaryCategory: 'KERRITS' })).toEqual(['克重(K)'])
  })

  it('refuses to reuse one customer\'s dictionary for another customer', async () => {
    // The snippet path reuses the last built dictionary so a user can keep
    // translating with terminology they just curated. Before the bucket
    // travelled with the cache, a KERRITS dictionary silently applied to an
    // ACME snippet — the same cross-customer leak the KB filter prevents.
    const dictPath = join(dataDir, 'kerrits-dictionary.json')
    writeFileSync(dictPath, JSON.stringify({ 'fabric weight': '克重(K)-DICT' }, null, 2), 'utf8')

    const build = await ipc<{ ok: boolean }>(base, 'ai:translate-build-dictionary', [
      {
        inputPath: dictPath,
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        glossaryCategory: 'KERRITS',
        useLlm: false,
      },
    ])
    expect(build.ok).toBe(true)

    const snippet = async (bucket: Record<string, string>): Promise<Record<string, unknown>> => {
      const { result } = await ipc<Record<string, unknown>>(base, 'home:translate-snippet', [
        { text: SOURCE, targetLang: 'zh-CN', sourceLang: 'en-US', ...bucket },
      ])
      return result
    }

    // Same bucket: the dictionary is reused (the stub echoes its term).
    const same = await snippet({ glossaryCategory: 'KERRITS' })
    expect(same.dictionary).not.toBeNull()

    // Different bucket: the KERRITS dictionary must not apply.
    const other = await snippet({ glossaryCategory: 'ACME' })
    expect(other.dictionary).toBeNull()
    expect(other.translation).not.toContain('克重(K)-DICT')
  })

  it('keeps the bucket on an entry saved through ai:save-translation-memory', async () => {
    // The reader keys the TM on the bucket, so an entry written by the UI's
    // "save to memory" button has to carry one. Saved unscoped, it became a
    // cache hit for every customer — the same cross-customer leak the reader
    // key was added to prevent, just reintroduced from the writer side.
    const saved = await ipc<{ ok: boolean; savedCount: number; skippedCount: number }>(
      base,
      'ai:save-translation-memory',
      [
        {
          scene: 'document',
          sourceLang: 'en-US',
          targetLang: 'zh-CN',
          glossaryCategory: 'KERRITS',
          units: [
            { unitId: 'm1', sourceText: 'waistband elastic', translatedText: '腰头弹性带(K)' },
          ],
        },
      ],
    )
    expect(saved.result.ok).toBe(true)
    expect(saved.result.savedCount).toBe(1)

    const batch = async (bucket: Record<string, string>): Promise<string | undefined> => {
      const { result } = await ipc<{
        ok: boolean
        units: Array<{ translatedText?: string; status?: string }>
      }>(base, 'ai:translate-batch', [
        {
          targetLang: 'zh-CN',
          sourceLang: 'en-US',
          memoryEnabled: true,
          ...bucket,
          units: [{ unitId: 'r', sourceText: 'waistband elastic' }],
        },
      ])
      return result.units[0]?.translatedText
    }

    expect(await batch({ glossaryCategory: 'KERRITS' })).toBe('腰头弹性带(K)')
    // ACME must not inherit it.
    expect(await batch({ glossaryCategory: 'ACME' })).not.toBe('腰头弹性带(K)')
  })

  it('does not replay one customer translation for another from the memory cache', async () => {
    const post = async (body: Record<string, unknown>): Promise<string | undefined> => {
      const res = await fetch(`${base}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetLanguage: 'zh-CN',
          sourceLanguage: 'en-US',
          units: [{ unitId: 'm', kind: 'paragraph', sourceText: SOURCE, order: 0 }],
          ...body,
        }),
      })
      const json = (await res.json()) as { ok: boolean; units?: Array<{ translatedText?: string }> }
      expect(json.ok).toBe(true)
      return json.units?.[0]?.translatedText
    }

    // Memory is on here. Without the bucket in the TM key the second call
    // would return the first call's answer instead of translating again.
    expect(await post({ glossaryCategory: 'KERRITS' })).toBe('克重(K)')
    expect(await post({ glossaryCategory: 'ACME' })).toBe('克重(A)')
    expect(await post({})).toBe('克重')
  })
})
