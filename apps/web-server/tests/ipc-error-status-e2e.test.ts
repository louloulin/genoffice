/**
 * Every registered channel must answer a malformed call with a 4xx.
 *
 * A no-argument call is the simplest malformed request the renderer can build
 * (a panel that opens before its document id is set, a bridge that forwards a
 * partially-filled form). Before the status mapping existed, 85 of 531
 * channels answered that call with a bare 500 — the retry logic could not tell
 * a bug on its own side from a server fault, and real 500s were lost in the
 * noise. `WEB_UNSUPPORTED` is the one intentional 5xx: those channels exist in
 * the registry but have no web implementation, so the client is told to stop
 * asking rather than to retry.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let server: ChildProcess | undefined
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

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'genoffice-ipc-status-e2e-'))
  const port = 21000 + Math.floor(Math.random() * 4000)
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
  if (dataDir) rmSync(dataDir, { recursive: true, force: true })
})

describe('IPC transport status mapping', () => {
  it('never answers a no-argument call with an unexplained 500', async () => {
    const listed = (await (await fetch(`${base}/api/channels`)).json()) as { channels: string[] }
    expect(listed.channels.length).toBeGreaterThan(400)

    const unexplained: Array<{ channel: string; status: number; body: string }> = []
    for (const channel of listed.channels) {
      const res = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: [] }),
      })
      if (res.status < 500) continue
      const body = await res.text()
      // 501 is the documented "this channel has no web implementation" answer.
      let code: string | undefined
      try {
        code = (JSON.parse(body) as { error?: { code?: string } }).error?.code
      } catch {
        /* non-JSON 5xx is never acceptable */
      }
      if (res.status === 501 && code === 'WEB_UNSUPPORTED') continue
      unexplained.push({ channel, status: res.status, body: body.slice(0, 200) })
    }

    expect(
      unexplained,
      `channels answered a malformed request with a server error:\n${unexplained
        .map((u) => `  ${u.status} ${u.channel} → ${u.body}`)
        .join('\n')}`,
    ).toEqual([])
  }, 120_000)

  it('classifies a destructure failure as 400 instead of 500', async () => {
    const res = await fetch(`${base}/api/ipc/${encodeURIComponent('collab:join')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error?: { code?: string; channel?: string } }
    expect(body.error?.code).toBe('INVALID_ARGUMENT')
    expect(body.error?.channel).toBe('collab:join')
  })

  it('reports a missing file as 404 so the UI can say "moved or deleted"', async () => {
    const res = await fetch(`${base}/api/ipc/${encodeURIComponent('pdf:read-file')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: ['/definitely/not/here.pdf'] }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe('NOT_FOUND')
  })

  it('keeps an unsupported channel at 501 with its structured code', async () => {
    const res = await fetch(`${base}/api/ipc/${encodeURIComponent('ai:slides-translate')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    expect(res.status).toBe(501)
    const body = (await res.json()) as { error?: { code?: string; reason?: string } }
    expect(body.error?.code).toBe('WEB_UNSUPPORTED')
    expect(body.error?.reason).toBe('renderer-side skill')
  })
})
  it('reports docs:respell-kick as a web no-op instead of a swallowed 404', async () => {
    // The desktop main process types one trusted keystroke (Blink respells
    // on real input only). The web bridge has no way to do that, and the
    // previous web build returned 404 `IPC_NO_HANDLER` — the renderer's
    // `.catch(() => undefined)` swallowed it and a re-enable of spellcheck
    // in the browser silently did nothing. The web-server now registers a
    // deliberate no-op channel so the caller gets a 200 it can branch on
    // and the renderer can stop logging the missing handler.
    const res = await fetch(`${base}/api/ipc/${encodeURIComponent('docs:respell-kick')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result?: { ok?: boolean; supported?: boolean } }
    expect(body.result?.ok).toBe(true)
    expect(body.result?.supported).toBe(false)
  })

