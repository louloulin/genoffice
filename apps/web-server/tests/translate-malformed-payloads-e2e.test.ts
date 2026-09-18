/**
 * Malformed translation payloads are reported, not thrown.
 *
 * The channel sweep in `ipc-error-status-e2e.test.ts` proves that calling a
 * channel with *no* arguments answers a 4xx. This suite covers the next case
 * along: an argument object that is present but has the wrong shape — a number
 * where a string belongs, an object where an array belongs, a `null` element.
 *
 * Those used to throw out of the handler, which the transport reported as HTTP
 * 500 and the UI rendered as the raw JavaScript expression
 * `(req.text ?? "").trim is not a function`. A caller reading that cannot tell
 * whether to fix its own request — which is what every one of these needs — or
 * to retry. `ai:save-translation-memory` also dereferenced `null` elements, so
 * a batch with one bad entry threw away the good ones with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

interface IpcResponse<T = unknown> {
  ok?: boolean
  result?: T
  error?: { message?: string; code?: string }
}

let server: ChildProcess | undefined
let stub: Server | undefined
let stubBase: string
let base: string
let dataDir: string

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
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

async function ipc<T = unknown>(
  channel: string,
  args: unknown[],
): Promise<{ status: number; body: IpcResponse<T> }> {
  const res = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args }),
  })
  return { status: res.status, body: (await res.json()) as IpcResponse<T> }
}

beforeAll(async () => {
  // The stub provider echoes the source text back, so the SSE assertions below
  // see a settled batch instead of a provider retry budget draining first.
  stub = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'stub',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '你好' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })()
  })
  await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', () => resolve()))
  const stubAddress = stub!.address()
  stubBase = `http://127.0.0.1:${typeof stubAddress === 'object' && stubAddress ? stubAddress.port : 0}/v1`

  dataDir = mkdtempSync(join(tmpdir(), 'genoffice-translate-shape-e2e-'))
  const port = 25000 + Math.floor(Math.random() * 3000)
  base = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [join(__dirname, '..', 'dist', 'bundle', 'index.js')], {
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
  await waitForHealth()
}, 60_000)

afterAll(() => {
  server?.kill('SIGTERM')
  stub?.close()
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('malformed translation payloads', () => {
  it('rejects a non-string instruction on ai:translate', async () => {
    for (const instruction of [123, {}, [], true]) {
      const { status, body } = await ipc<{ ok: boolean; error?: string }>('ai:translate', [
        { instruction, targetLang: 'zh-CN' },
      ])
      expect(status, `instruction=${JSON.stringify(instruction)}`).toBe(200)
      expect(body.result?.ok).toBe(false)
      expect(body.result?.error).toBe('ai:translate expected `instruction` to be a string')
    }
  })

  it('rejects a non-array units on ai:translate-batch', async () => {
    for (const units of ['nope', {}, 3, true]) {
      const { status, body } = await ipc<{ ok: boolean; error?: string; units?: unknown[] }>(
        'ai:translate-batch',
        [{ units, targetLang: 'zh-CN' }],
      )
      expect(status, `units=${JSON.stringify(units)}`).toBe(200)
      expect(body.result?.ok).toBe(false)
      expect(body.result?.error).toBe('ai:translate-batch expected `units` to be an array')
      // The response still carries the field the renderer iterates.
      expect(body.result?.units).toEqual([])
    }
  })

  it('rejects a non-string text on home:translate-snippet', async () => {
    for (const text of [123, {}, [], true]) {
      const { status, body } = await ipc<{ ok: boolean; error?: string }>('home:translate-snippet', [
        { text, targetLang: 'zh-CN' },
      ])
      expect(status, `text=${JSON.stringify(text)}`).toBe(200)
      expect(body.result?.ok).toBe(false)
      expect(body.result?.error).toBe('home:translate-snippet expected `text` to be a string')
    }
  })

  it('rejects a non-array units on ai:save-translation-memory', async () => {
    const { status, body } = await ipc<{ ok: boolean; error?: string }>(
      'ai:save-translation-memory',
      [{ units: 'nope' }],
    )
    expect(status).toBe(200)
    expect(body.result?.ok).toBe(false)
    expect(body.result?.error).toBe('units must be an array')
  })

  it('reports a malformed batch element as a failed unit, not a 500', async () => {
    // `units` elements arrive untyped. A null element used to leave a hole in
    // the settled array — `every` skips holes (the batch claimed `ok`) and
    // `find` on one threw, which the transport answered as 500. A non-string
    // `sourceText` threw straight out of the fan-out loop.
    const { status, body } = await ipc<{
      ok: boolean
      units?: Array<{ ok: boolean; status?: string; errorMessage?: string; sourceText?: string }>
    }>('ai:translate-batch', [
      { targetLang: 'zh-CN', units: [null, { sourceText: 123 }, 'nope'] },
    ])
    expect(status).toBe(200)
    expect(body.result?.ok).toBe(false)
    // Every index survives, so the renderer can map results back to units.
    expect(body.result?.units).toHaveLength(3)
    for (const unit of body.result?.units ?? []) {
      expect(unit.ok).toBe(false)
      expect(unit.status).toBe('failed')
      expect(unit.errorMessage).toMatch(/expected unit \d+/)
    }
  })

  it('rejects a non-string inputPath on the output-path helper', async () => {
    // `String(123)` answered `ok: true` with "123_translated" — a path the
    // caller hands straight to the translator for a value that never named a
    // file. Only a string can name one.
    for (const inputPath of [123, true, {}, ['a']]) {
      const { status, body } = await ipc<{ ok: boolean; outputPath?: string; error?: string }>(
        'ai:translate-file-output-path',
        [inputPath],
      )
      expect(status, `inputPath=${JSON.stringify(inputPath)}`).toBe(200)
      expect(body.result?.ok).toBe(false)
      expect(body.result?.outputPath).toBeUndefined()
      expect(body.result?.error).toBe('expected a non-empty inputPath')
    }
  })

  it('rejects a non-string file path instead of throwing from startsWith', async () => {
    // `isSupportedExtension` called `.startsWith` on its argument, so a number
    // or an object threw "pathOrExt.startsWith is not a function" and the
    // transport reported a server fault for a plain shape error.
    for (const channel of ['ai:translate-file', 'ai:translate-file-auto'] as const) {
      for (const inputPath of [123, {}, ['a']]) {
        const { status, body } = await ipc<{ ok: boolean; error?: string }>(channel, [
          { inputPath, targetLang: 'zh-CN' },
        ])
        expect(status, `${channel} inputPath=${JSON.stringify(inputPath)}`).toBe(200)
        expect(body.result?.ok).toBe(false)
        expect(body.result?.error).toMatch(/Unsupported file type/)
      }
    }
  })

  it('rejects a non-string targetLang on the KB resolver', async () => {
    // A number fell through the resolver into the rendered prompt block as
    // "Translation rules (auto -> 5)" — a prompt that names nothing.
    const { status, body } = await ipc<{ ok: boolean; error?: string }>(
      'ai:translation-kb-resolve',
      [{ targetLang: 5 }],
    )
    expect(status).toBe(200)
    expect(body.result?.ok).toBe(false)
    expect(body.result?.error).toBe('ai:translation-kb-resolve expected non-empty `targetLang`')
  })

  it('answers the SSE stream for malformed units instead of hanging', async () => {
    // A stub provider keeps this deterministic — without a live provider the
    // forwarder spends its retry budget before the batch settles.
    await ipc('ai:set-settings', [
      {
        provider: 'openai',
        providers: { openai: { apiKey: 'k', model: 'gpt-4o-mini', baseUrl: stubBase } },
      },
    ])

    // The stream handler wrote its 200 `text/event-stream` header *before*
    // normalising `units`, and the try block started after that. A null
    // element threw out of the normalisation, so no `end()` ever ran: the
    // caller hung on an open socket until its own timeout, with no way to
    // learn what went wrong. The whole post-header region is guarded now, so
    // the response always ends.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await fetch(`${base}/api/ai/translate/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: 'malformed-units',
          targetLanguage: 'zh-CN',
          units: [null, { unitId: 'ok', sourceText: 'Hello' }],
        }),
        signal: controller.signal,
      })
      // Whether the batch then fails (no provider) or succeeds, the point is
      // that every unit settles onto the wire and the stream closes.
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).toContain('event: unit')
      expect(body).toContain('"warnings":["malformed-unit"]')
      expect(body).toContain('"errorMessage":"ai:translate-batch expected unit 0 to be an object"')
      // The terminal frame is what proves the socket was ended rather than
      // left open; without it this fetch would not have resolved at all.
      expect(body).toContain('event: complete')
    } finally {
      clearTimeout(timer)
    }
  })

  it('rejects a non-array units on the streaming HTTP endpoint', async () => {
    const res = await fetch(`${base}/api/ai/translate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguage: 'zh-CN', units: 'nope' }),
    })
    // The SSE contract reports a bad `units` value as an `error` event, so the
    // status is 200 — what must not happen is a hang or a 500.
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('expected non-empty `units` array')
  })

  it('rejects a non-array units on the batch HTTP endpoint with 400', async () => {
    const res = await fetch(`${base}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetLanguage: 'zh-CN', units: 'nope' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(body.error?.code).toBe('INVALID_ARGUMENT')
    expect(body.error?.message).toContain('units')
  })

  it('keeps a malformed batch element in place on the batch HTTP endpoint', async () => {
    const res = await fetch(`${base}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguage: 'zh-CN',
        units: [null, { unitId: 'bad', sourceText: 42 }, { unitId: 'ok', sourceText: 'Hello' }],
      }),
    })
    // No provider in this suite → the batch fails, but the failure must still
    // carry one settled entry per input unit.
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      units?: Array<{ unitId?: string; status?: string; errorMessage?: string }>
    }
    expect(body.ok).toBe(false)
    expect(body.units).toHaveLength(3)
    expect(body.units?.[0]?.errorMessage).toMatch(/expected unit 0/)
    expect(body.units?.[1]?.errorMessage).toMatch(/expected unit 1/)
    expect(body.units?.[2]?.unitId).toBe('ok')
  })

  it('counts malformed memory units as skipped instead of dropping them', async () => {
    const { status, body } = await ipc<{ ok: boolean; savedCount: number; skippedCount: number }>(
      'ai:save-translation-memory',
      [
        {
          sourceLang: 'en-US',
          targetLang: 'zh-CN',
          units: [null, {}, { unitId: 'bad-target', sourceText: 'Hello' }, { unitId: 'ok', sourceText: 'Hi', translatedText: '你好' }],
        },
      ],
    )
    expect(status).toBe(200)
    expect(body.result?.ok).toBe(true)
    // One usable unit; the other three must be accounted for, not silently
    // dropped — reporting "saved 1" for a four-entry batch hides the loss.
    expect(body.result?.savedCount).toBe(1)
    expect(body.result?.skippedCount).toBe(3)
  })

  it('rejects a non-string glossaryCategory / sourceLanguage / customerName on the batch HTTP endpoint', async () => {
    // `glossaryCategory`, `customerName` and `sourceLanguage` ride into the
    // system prompt and into the bucket filter. Without a type guard they
    // crashed `buildTranslateSystemPrompt` (`.trim is not a function`) and the
    // English-label lookup (`value3.indexOf is not a function`), and the
    // handler answered 500 with the raw JS expression. Each bad field now
    // surfaces as 400 with a structured code.
    for (const field of ['glossaryCategory', 'customerName', 'sourceLanguage']) {
      for (const value of [7, {}, [], true]) {
        const res = await fetch(`${base}/api/ai/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetLanguage: 'zh-CN',
            units: [{ unitId: 'u1', sourceText: 'Hello world' }],
            [field]: value,
          }),
        })
        expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(400)
        const body = (await res.json()) as { error?: { code?: string; message?: string } }
        expect(body.error?.code).toBe('INVALID_ARGUMENT')
        expect(body.error?.message).toContain(field)
      }
    }
  })

  it('rejects a non-string glossaryCategory on ai:translate, ai:translate-batch and ai:save-translation-memory', async () => {
    // A non-string glossaryCategory used to crash inside the system prompt
    // builder (`opts.glossaryCategory.trim is not a function`) and inside the
    // language lookup (`value3.indexOf is not a function`). Now ai:translate
    // and ai:translate-batch return an explicit error; ai:save-translation-memory
    // skips the write with `skippedCount` reflecting the rejected units.
    for (const value of [7, {}, [], true]) {
      for (const channel of ['ai:translate', 'ai:translate-batch']) {
        const { status, body } = await ipc<{ ok: boolean; error?: string }>(channel, [
          channel === 'ai:translate-batch'
            ? {
                targetLang: 'zh-CN',
                units: [{ unitId: 'u1', sourceText: 'Hello world' }],
                glossaryCategory: value,
              }
            : {
                instruction: 'Hello world',
                targetLang: 'zh-CN',
                glossaryCategory: value,
              },
        ])
        expect(status, `${channel} glossaryCategory=${JSON.stringify(value)}`).toBe(200)
        expect(body.result?.ok).toBe(false)
        expect(body.result?.error).toMatch(/glossaryCategory/i)
      }

      const saved = await ipc<{ ok: boolean; error?: string; skippedCount?: number }>(
        'ai:save-translation-memory',
        [
          {
            sourceLang: 'en-US',
            targetLang: 'zh-CN',
            glossaryCategory: value,
            units: [{ unitId: 'ok', sourceText: 'Hi', translatedText: '你好' }],
          },
        ],
      )
      expect(saved.status).toBe(200)
      expect(saved.body.result?.ok).toBe(false)
      expect(saved.body.result?.error).toMatch(/glossaryCategory must be a string/i)
    }
  })

  it('reports a non-string bucket on the streaming HTTP endpoint without hanging', async () => {
    // The SSE endpoint used to keep its socket open until the caller's own
    // timeout after a `value3.indexOf is not a function` thrown past
    // writeHead; the new shape guard emits a structured `error` event before
    // the 200 settles, so the stream ends cleanly.
    const res = await fetch(`${base}/api/ai/translate/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetLanguage: 'zh-CN',
        units: [{ unitId: 'u1', sourceText: 'Hello world' }],
        glossaryCategory: 7,
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('expected `glossaryCategory` to be a string')
  })
})
