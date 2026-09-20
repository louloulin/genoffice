/**
 * Translation failure surfacing E2E — one reason, every entry point.
 *
 * The translate-skill tools report failures inside `details.error` and mirror
 * the text in their `content` block. `callTranslateTool` used to read only the
 * `content` text and drop `details`, so the handlers that check `result.error`
 * (`ai:translate-batch`, the generate bridges) got `undefined` and answered a
 * bare `ok: false` — an empty failure banner with no provider message. The
 * batch handler then returned per-unit `errorMessage` only, leaving callers
 * that read the top-level `error` field with nothing either.
 *
 * Both are observable without a live provider: point the active provider at a
 * dead port, and assert the classified message survives from the pi tool all
 * the way out to the IPC response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'

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

/** A port nothing listens on, so every provider call is a connection refusal. */
const DEAD_PORT = 1

describe('translation failure surfacing E2E', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-translate-fail-e2e-'))
    const port = 22000 + Math.floor(Math.random() * 7000)
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

    // Route the active provider at a refused connection. `baseUrl` overrides
    // the vendor endpoint, which is also how regional mirrors are configured.
    await ipc(base, 'ai:set-settings', [
      {
        provider: 'openai',
        providers: {
          openai: {
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            baseUrl: `http://127.0.0.1:${DEAD_PORT}/v1`,
          },
        },
      },
    ])
  }, 90_000)

  afterAll(async () => {
    await stopServer(server, dataDir)
  })

  it('reports the provider reason from ai:translate-batch, per unit and top-level', async () => {
    const { ok, result } = await ipc<{
      ok: boolean
      error?: string
      units: Array<{ ok: boolean; unitId: string; errorMessage?: string }>
    }>(base, 'ai:translate-batch', [
      {
        targetLang: 'zh-CN',
        sourceLang: 'en-US',
        units: [
          { unitId: 'u1', sourceText: 'Hello world' },
          { unitId: 'u2', sourceText: 'Good morning' },
        ],
      },
    ])
    expect(ok).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.units).toHaveLength(2)
    for (const unit of result.units) {
      expect(unit.ok).toBe(false)
      // Each unit carries its own reason instead of an empty string.
      expect(unit.errorMessage, `unit ${unit.unitId} lost its failure reason`).toBeTruthy()
    }
    // The top-level field the docs/sheets bridges read is populated too.
    expect(result.error, 'batch lost its top-level failure reason').toBeTruthy()
    expect(result.units[0]?.errorMessage).toBe(result.error)
  })

  it('reports the provider reason from home:translate-snippet', async () => {
    const { ok, result } = await ipc<{ ok: boolean; status: string; error?: string }>(
      base,
      'home:translate-snippet',
      [{ text: 'Hello world', targetLang: 'zh-CN', sourceLang: 'en-US' }],
    )
    expect(ok).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.error, 'snippet lost its failure reason').toBeTruthy()
    // Not the bare fallback the handler uses when it has nothing else.
    expect(result.error).not.toBe('translate_text failed')
  })

  it('reports the provider reason from ai:translate', async () => {
    const { ok, result } = await ipc<{ ok: boolean; error?: string }>(base, 'ai:translate', [
      { instruction: 'Hello world', targetLang: 'zh-CN', sourceLang: 'en-US' },
    ])
    expect(ok).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.error, 'ai:translate lost its failure reason').toBeTruthy()
    expect(result.error).not.toBe('translate_text failed')
  })
})
