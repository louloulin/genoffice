import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createHostContext, startUiHost, type UiHostHandle } from '../src/ui/host'

// In-repo checkout of the docs renderer (tier-3 resolution does not apply
// inside vitest, which imports src/ directly rather than dist/host.cjs).
const DOCS_RENDERER_DIR = fileURLToPath(
  new URL('../../../apps/docs/out/renderer', import.meta.url),
)

let host: UiHostHandle | null = null

/**
 * assetsDir is a root whose per-app subdirs are renderer dirs; the repo has
 * apps/docs/out/renderer instead, so build a tiny temp root with a symlink.
 */
async function bootHost(): Promise<UiHostHandle> {
  const { mkdtempSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'office-ai-ui-'))
  symlinkSync(DOCS_RENDERER_DIR, join(root, 'docs'), 'dir')
  host = await startUiHost({ assetsDir: root })
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function invoke(channel: string, args: unknown[] = []): Promise<{ status: number; body: any }> {
  const response = await fetch(`${host!.url}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ipc-session': 'test-session',
    },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

describe('startUiHost', () => {
  it('binds an ephemeral loopback port and answers /health', async () => {
    const h = await bootHost()
    expect(h.port).toBeGreaterThan(0)
    const response = await fetch(`${h.url}/health`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('registers app:* channels and the docs-boot stub set', async () => {
    const h = await bootHost()
    expect(h.context.registry.handlerCount()).toBeGreaterThanOrEqual(60)
    const language = await invoke('app:get-language')
    expect(language).toEqual({ status: 200, body: { ok: true, result: 'zh' } })
    const theme = await invoke('app:get-theme')
    expect(theme.body.result).toBe('light')
    const prefs = await invoke('app:get-ai-panel-prefs')
    expect(prefs.body.result).toEqual({ fontSize: 'default', customFontSize: 14, spellcheck: true })
  })

  it('answers boot-critical stubs with renderer-expected shapes', async () => {
    await bootHost()
    expect((await invoke('docs:recent')).body.result).toEqual([])
    expect((await invoke('docs:consume-pending-open')).body.result).toBeNull()
    expect((await invoke('win:list')).body.result).toEqual([])
    expect((await invoke('project:list')).body.result).toEqual([])
    expect((await invoke('docs:font-metrics', ['Arial'])).body.result).toMatchObject({
      family: 'Arial',
      unitsPerEm: 1000,
    })
    const settings = (await invoke('ai:get-settings')).body.result
    expect(settings.provider).toBe('genspark')
    expect(settings.gskToolsEnabled).toBe(false)
  })

  it('returns 404 IPC_NO_HANDLER for unregistered channels', async () => {
    await bootHost()
    const result = await invoke('totally:unknown')
    expect(result.status).toBe(404)
    expect(result.body.error.code).toBe('IPC_NO_HANDLER')
  })

  it('rejects non-array args with 400', async () => {
    const h = await bootHost()
    const response = await fetch(`${h.url}/api/ipc/${encodeURIComponent('app:get-language')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: 'nope' }),
    })
    expect(response.status).toBe(400)
  })

  it('encodes byte results through the tagged transport codec', async () => {
    const h = await bootHost()
    h.context.registry.registerHandle('test:bytes', () => new Uint8Array([1, 2, 255]))
    const result = await invoke('test:bytes')
    expect(result.body.result).toEqual({ __ipcBytes: 'u8', b64: 'AQL/' })
  })

  it('pushes handler-sent events to the SSE stream of the invoking session', async () => {
    const h = await bootHost()
    h.context.registry.registerHandle('test:push', (event) => {
      event.sender.send('test:event', { hello: 'world' })
      return 'done'
    })
    const stream = await fetch(`${h.url}/api/ipc/events?session=sse-test`)
    const reader = stream.body!.getReader()
    const header = new TextDecoder().decode((await reader.read()).value)
    expect(header).toContain(': connected')
    const framePromise = reader.read().then(({ value }) => new TextDecoder().decode(value))
    const invokeResult = await fetch(`${h.url}/api/ipc/${encodeURIComponent('test:push')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ipc-session': 'sse-test' },
      body: JSON.stringify({ args: [] }),
    })
    expect(invokeResult.status).toBe(200)
    const frame = await framePromise
    expect(frame).toContain('test:event')
    expect(frame).toContain('world')
    void reader.cancel()
  })

  it('serves the renderer index.html for the default app', async () => {
    const h = await bootHost()
    const response = await fetch(`${h.url}/docs`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('<!doctype html>')
  })

  it('refuses path traversal outside the app asset root', async () => {
    const h = await bootHost()
    const response = await fetch(`${h.url}/docs/..%2f..%2fpackage.json`)
    expect(response.status).toBe(404)
  })

  it('gates /api/** behind the token when one is configured', async () => {
    host = await startUiHost({ token: 'sekret' })
    const denied = await fetch(`${host.url}/health`) // /health is unauthenticated by design
    expect(denied.status).toBe(200)
    const blocked = await fetch(`${host.url}/api/channels`)
    expect(blocked.status).toBe(401)
    const allowed = await fetch(`${host.url}/api/channels?token=sekret`)
    expect(allowed.status).toBe(200)
    const viaHeader = await fetch(`${host.url}/api/channels`, {
      headers: { authorization: 'Bearer sekret' },
    })
    expect(viaHeader.status).toBe(200)
  })

  it('exposes /api/channels with a namespace histogram on ?counts=1', async () => {
    const h = await bootHost()
    const view = (await (await fetch(`${h.url}/api/channels?counts=1`)).json()) as {
      counts: Record<string, number>
      total: number
      channels: string[]
    }
    expect(view.total).toBe(view.channels.length)
    expect(view.counts.app).toBeGreaterThanOrEqual(8)
  })
})

describe('attachUi', () => {
  it('passes non-matching requests through to the existing listener', async () => {
    const { createServer } = await import('node:http')
    const { attachUi } = await import('../src/ui/host')
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ from: 'host-app' }))
    })
    const attached = attachUi(server, { basePath: '/office-ai' })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const base = `http://127.0.0.1:${address.port}`

    const own = await fetch(`${base}/office-ai/health`)
    expect(own.status).toBe(200)
    expect(await own.json()).toEqual({ ok: true })

    const passthrough = await fetch(`${base}/anything-else`)
    expect(await passthrough.json()).toEqual({ from: 'host-app' })

    await new Promise<void>((resolve) => server.close(resolve))
    attached.detach()
    server.closeAllConnections?.()
  })
})