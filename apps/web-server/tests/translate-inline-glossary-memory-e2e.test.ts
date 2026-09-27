/**
 * Inline glossary + inline memory on the HTTP translate surface.
 *
 * Dataflarework keeps its term store and translation memory outside GenOffice
 * (multi-tenant DB rows), so the contract is "send the applicable rows with
 * every request" rather than a sync protocol. `POST /api/ai/translate` now
 * accepts `glossary[]`, `memory[]` and `cacheScope`, threads them into
 * `translateBatchCore`, and derives the translation-memory bucket from
 * `cacheScope`.
 *
 * The assertions are deliberately about *behaviour*, not about "the field was
 * forwarded": a request that carries a term must come back with the term's
 * target in the translation, and a request-scoped memory entry must satisfy
 * the unit without a provider call. Asserting the field round-trips would pass
 * against a handler that received the glossary and then dropped it.
 *
 * The provider is a local stub that echoes `<source_text>` back, so whatever
 * `applyTerminology` does to the answer is observable in `translatedText`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

interface UnitResult {
  unitId: string
  sourceText: string
  translatedText?: string
  status?: 'translated' | 'memory-hit' | 'failed'
  matchedTerms?: string[]
}

interface BatchResult {
  ok: boolean
  units?: UnitResult[]
  error?: string
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
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(() => r(), 250))
  }
  throw new Error(`web-server did not become healthy within ${timeoutMs}ms`)
}

/** Echoes the prompt's `<source_text>` back as the translation and counts how
 *  many times it was called, so "no provider call" is directly observable. */
function startFakeProvider(): Promise<{ server: Server; port: number; calls: () => number }> {
  let count = 0
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        try {
          count += 1
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
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        calls: () => count,
      })
    })
  })
}

describe('inline glossary / memory / cacheScope on /api/ai/translate', () => {
  let server: ChildProcess | undefined
  let fake: { server: Server; port: number; calls: () => number }
  let base: string
  let dataDir: string

  async function post(body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${base}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceLanguage: 'en-US', targetLanguage: 'zh-CN', ...body }),
    })
    return { status: res.status, body: await res.json() }
  }

  async function translate(body: Record<string, unknown>): Promise<BatchResult> {
    return (await post(body)).body as BatchResult
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-inline-glossary-'))
    fake = await startFakeProvider()
    const port = 25000 + Math.floor(Math.random() * 3000)
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

    // Route the active provider at the stub. No KB entries are seeded: the
    // whole point is that these terms arrive inline with the request.
    await ipc(base, 'ai:set-settings', [
      {
        provider: 'openai',
        providers: {
          openai: { apiKey: 'test-key', model: 'gpt-4o-mini', baseUrl: `http://127.0.0.1:${fake.port}` },
        },
      },
    ])
  }, 90_000)

  afterAll(async () => {
    fake?.server.close()
    await stopServer(server, dataDir)
  })

  it('applies an inline glossary so the same paragraph translates differently', async () => {
    const units = [{ unitId: 'g1', sourceText: 'fabric weight sample' }]

    const withoutGlossary = await translate({ units })
    expect(withoutGlossary.ok).toBe(true)
    const plain = withoutGlossary.units?.[0]?.translatedText ?? ''
    // The stub echoes the source, so with no term to enforce the source term
    // must survive untouched.
    expect(plain).toContain('fabric weight')
    expect(plain).not.toContain('克重')

    const withGlossary = await translate({
      units,
      glossary: [{ source: 'fabric weight', target: '克重' }],
    })
    expect(withGlossary.ok).toBe(true)
    const enforced = withGlossary.units?.[0]?.translatedText ?? ''
    expect(enforced).toContain('克重')
    expect(withGlossary.units?.[0]?.matchedTerms).toContain('fabric weight')

    // The assertion that matters: identical input, different output.
    expect(enforced).not.toBe(plain)
  })

  it('serves an inline memory entry without calling the provider', async () => {
    const sourceText = 'inline memory sentinel sentence'
    const callsBefore = fake.calls()

    const result = await translate({
      units: [{ unitId: 'm1', sourceText }],
      memory: [{ sourceText, targetText: '内联记忆哨兵句' }],
    })

    expect(result.ok).toBe(true)
    expect(result.units?.[0]?.status).toBe('memory-hit')
    expect(result.units?.[0]?.translatedText).toBe('内联记忆哨兵句')
    expect(fake.calls()).toBe(callsBefore)
  })

  it('rejects a malformed glossary instead of silently dropping it', async () => {
    const { status, body } = await post({
      units: [{ unitId: 'bad1', sourceText: 'anything' }],
      glossary: [{ source: 'only-a-source' }],
    })
    expect(status).toBe(400)
    // Naming the offending index is the point: silently dropping the entry
    // would change the translation with no signal to the caller.
    expect((body as { error?: { message?: string } }).error?.message).toContain('glossary[0].target')
  })

  it('rejects an empty term rather than mangling the unit with it', async () => {
    // `applyTerminology` rewrites via `text.split(source).join(target)`. An
    // empty `source` matches at every position, so the translation comes back
    // with the target spliced between every character; an empty `target`
    // deletes the matched term outright. Both are structurally valid strings,
    // so a shape-only check lets them through and corrupts the whole unit.
    const blankSource = await post({
      units: [{ unitId: 'blank-src', sourceText: 'anything' }],
      glossary: [{ source: '', target: '克重' }],
    })
    expect(blankSource.status).toBe(400)
    expect((blankSource.body as { error?: { message?: string } }).error?.message).toContain(
      'glossary[0].source',
    )

    const blankTarget = await post({
      units: [{ unitId: 'blank-tgt', sourceText: 'anything' }],
      memory: [{ sourceText: 'anything', targetText: '' }],
    })
    expect(blankTarget.status).toBe(400)
    expect((blankTarget.body as { error?: { message?: string } }).error?.message).toContain(
      'memory[0].targetText',
    )
  })

  it('keeps memory inside its cacheScope', async () => {
    const units = [{ unitId: 's1', sourceText: 'tenant scoped sentence' }]

    // Tenant A translates: the shared persistent TM now holds this pair under
    // the tenant-a bucket.
    const first = await translate({ units, cacheScope: 'tenant-a' })
    expect(first.ok).toBe(true)
    expect(first.units?.[0]?.status).not.toBe('memory-hit')
    const callsAfterFirst = fake.calls()

    // Tenant B must not be served tenant A's translation.
    const crossTenant = await translate({ units, cacheScope: 'tenant-b' })
    expect(crossTenant.ok).toBe(true)
    expect(crossTenant.units?.[0]?.status).not.toBe('memory-hit')
    expect(fake.calls()).toBeGreaterThan(callsAfterFirst)

    // Tenant A's own entry is still there — the bucket separates, it does not
    // disable, the memory.
    const callsBeforeRepeat = fake.calls()
    const repeat = await translate({ units, cacheScope: 'tenant-a' })
    expect(repeat.units?.[0]?.status).toBe('memory-hit')
    expect(fake.calls()).toBe(callsBeforeRepeat)
  })
})
