import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdtempSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startUiHost, type UiHostHandle } from '../src/ui/host'
import { hardenRendererCsp, parseEmbedQuery, supportedSdkCommands } from '../src/ui/embed'
import { EMBED_BRIDGE_SOURCE } from '../src/ui/embed/bridge'

const RENDERER_ROOT = fileURLToPath(new URL('../../../apps', import.meta.url))
const TOKEN = 'embed-test-token'

let host: UiHostHandle | null = null

/**
 * The asset resolver reads `<assetsDir>/<app>`, so the four renderer bundles are
 * symlinked under one temp root rather than the 60MB of real assets being copied
 * per test.
 */
async function bootHost(options: { token?: string; frameAncestors?: string } = {}): Promise<UiHostHandle> {
  const root = mkdtempSync(join(tmpdir(), 'office-ai-embed-'))
  for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
    symlinkSync(join(RENDERER_ROOT, app, 'out', 'renderer'), join(root, app), 'dir')
  }
  host = await startUiHost({ assetsDir: root, token: '', ...options })
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${host!.url}${path}`, init)
}

async function sdkCommand(name: string, args: unknown, docId?: string): Promise<Response> {
  const envelope: Record<string, unknown> = { name, args }
  if (docId !== undefined) envelope.docId = docId
  return get(`/api/ipc/sdk%3Acommand`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': 'embed-session' },
    body: JSON.stringify({ args: [envelope] }),
  })
}

function readEmbedConfig(html: string): Record<string, string> {
  const match = html.match(/<meta name="genoffice-embed-config" content="([^"]*)">/)
  if (!match) throw new Error('no genoffice-embed-config meta in the served page')
  return JSON.parse(match![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&amp;/g, '&'))
}

describe('embed page (M4)', () => {
  it('serves the bridge script as a standalone JS file', async () => {
    await bootHost()
    const response = await get('/embed/static/bridge.js')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    const body = await response.text()
    expect(body).toBe(EMBED_BRIDGE_SOURCE)
    // The three behaviours the SDK depends on must survive the port.
    expect(body).toContain('sendReady')
    expect(body).toContain('api/ipc/events')
    expect(body).toContain('sdk:command')
  })

  it('wraps the renderer page with the bridge, config and skeleton', async () => {
    await bootHost()
    const response = await get('/embed/report.docx?app=docs&nonce=n-123')
    expect(response.status).toBe(200)
    // The wrapper carries a live credential — never cacheable.
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()

    // Directory-relative base is what makes the page survive a path-prefixed
    // reverse-proxy mount; a root-relative base 404s the bundle behind one.
    expect(html).toContain('<base href="./">')
    // The bridge has to be reached the same way. Under `<base href="./">` a
    // root-absolute src asks the mount root for the bridge — at `/` that is the
    // same file, but under any `basePath` it 404s and the iframe never gets a
    // `ready`, so `whenReady()` hangs to timeout.
    expect(html).toContain('<script src="static/bridge.js"></script>')
    expect(html).not.toContain('src="/embed/static/bridge.js"')
    expect(html).toContain('<meta name="genoffice-nonce" content="n-123">')
    expect(html).toContain('go-skel')

    const config = readEmbedConfig(html)
    expect(config.docId).toBe('report.docx')
    expect(config.app).toBe('docs')
    expect(config.mode).toBe('edit')
    expect(config.theme).toBe('auto')
    expect(config.sessionId).toMatch(/^embed-/)

    // The renderer's own bundle must still be referenced.
    expect(html).toContain('./assets/')
  })

  // The wrapper is served to be framed, and `startUiHost` binds its own origin,
  // so the consumer's page is always cross-origin: the default `'self'` refuses
  // the frame and the iframe stays empty with no error on either side.
  it('honours the frameAncestors option so a consumer page may frame the wrapper', async () => {
    await bootHost({ frameAncestors: 'http://127.0.0.1:3000 http://localhost:5173' })
    const response = await get('/embed/report.docx?app=docs')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors http://127.0.0.1:3000 http://localhost:5173",
    )
  })

  it('falls back to a fail-closed frame-ancestors when the option is unusable', async () => {
    await bootHost({ frameAncestors: 'not-a-valid-source' })
    const response = await get('/embed/report.docx?app=docs')
    expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'self'")
  })

  it('serves the renderer bundle the wrapper resolves to', async () => {
    await bootHost()
    const assets = readdirSync(join(RENDERER_ROOT, 'docs', 'out', 'renderer', 'assets'))
    const bundle = assets.find((name) => name.endsWith('.js'))!
    const response = await get(`/embed/assets/${bundle}`)
    expect(response.status).toBe(200)
    // A JS asset served as text/html is a MIME failure the iframe cannot recover
    // from — it renders blank with no console clue.
    expect(response.headers.get('content-type')).toContain('javascript')
  })

  it('mints a distinct session id per request so two frames do not share a push channel', async () => {
    await bootHost()
    const first = readEmbedConfig(await (await get('/embed/a.docx')).text())
    const second = readEmbedConfig(await (await get('/embed/b.docx')).text())
    expect(first.sessionId).not.toBe(second.sessionId)
  })

  it('refuses a non-GET method and a malformed docId', async () => {
    await bootHost()
    const posted = await get('/embed/a.docx', { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(((await posted.json()) as { error: { code: string } }).error.code).toBe('METHOD_NOT_ALLOWED')

    // `decodeURIComponent('%XY')` throws URIError; uncaught it becomes an
    // unhandled rejection and the client hangs to socket timeout.
    const malformed = await get('/embed/%XY')
    expect(malformed.status).toBe(400)
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe('INVALID_ARGUMENT')
  })

  it('serves without a token but requires one when the host has a token', async () => {
    await bootHost()
    expect((await get('/embed/a.docx')).status).toBe(200)

    await host!.close()
    host = null
    await bootHost({ token: TOKEN })

    expect((await get('/embed/a.docx')).status).toBe(401)
    expect((await get(`/embed/a.docx?token=${TOKEN}`)).status).toBe(200)
    expect((await get('/embed/a.docx', { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
    expect(await (await get(`/embed/a.docx?token=${TOKEN}`)).text()).toContain(
      `<meta name="genoffice-token" content="${TOKEN}">`,
    )
  })

  it('falls back to an available app rather than serving one that is not installed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-ai-embed-docs-'))
    symlinkSync(join(RENDERER_ROOT, 'docs', 'out', 'renderer'), join(root, 'docs'), 'dir')
    host = await startUiHost({ assetsDir: root, apps: ['docs'], token: '' })
    expect(readEmbedConfig(await (await get('/embed/a.docx?app=sheets')).text()).app).toBe('docs')
  })

  it('honours basePath when the host is attached under a prefix', async () => {
    await bootHost()
    // Same-origin loopback cannot easily host two mounts, so assert the
    // stripping contract the router depends on: the embed routes are matched on
    // the base-stripped pathname, never the raw one.
    const { createServer } = await import('node:http')
    const { attachUi } = await import('../src/ui/host')
    const server = createServer((_request, response) => {
      response.writeHead(404).end('host app')
    })
    const root = mkdtempSync(join(tmpdir(), 'office-ai-embed-prefix-'))
    for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
      symlinkSync(join(RENDERER_ROOT, app, 'out', 'renderer'), join(root, app), 'dir')
    }
    attachUi(server, { basePath: '/office', assetsDir: root })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const response = await fetch(`http://127.0.0.1:${port}/office/embed/a.docx?app=slides`)
      expect(response.status).toBe(200)
      expect(readEmbedConfig(await response.text()).app).toBe('slides')
      expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

describe('embed query + CSP helpers', () => {
  it('parses presentation params and defaults them', () => {
    const parsed = parseEmbedQuery(
      new URL('http://x/embed/q3%2Freport.docx?app=slides&mode=view&theme=dark&lang=ja-JP&toolbar=minimal&title=Q3'),
      ['docs', 'sheets', 'slides', 'pdf'],
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.docId).toBe('q3/report.docx')
    expect(parsed.query).toEqual({
      app: 'slides',
      mode: 'view',
      theme: 'dark',
      lang: 'ja-JP',
      toolbar: 'minimal',
      title: 'Q3',
      nonce: null,
      aiPanel: null,
    })
  })

  it('strips unsafe script sources without touching style-src', () => {
    const input = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'"
    const output = hardenRendererCsp(input)
    expect(output).toContain("script-src 'self' 'wasm-unsafe-eval'")
    // An unscoped replace here once stripped this and broke every inline-styled
    // element in all four editors.
    expect(output).toContain("style-src 'self' 'unsafe-inline'")
  })
})

describe('sdk:command dispatch (M4)', () => {
  it('answers the eight host-backed commands and rejects the rest with 501', async () => {
    await bootHost()
    expect(supportedSdkCommands()).toEqual([
      'addComment',
      'createSnapshot',
      'listComments',
      'listVersions',
      'removeComment',
      'reportUsage',
      'resolveComment',
      'restoreVersion',
    ])

    // `insertImage`, `focus`, `setMode` and the three `ai*` commands have no
    // handler in apps/sdk either — the renderer's sink owns or refuses them.
    // A 501 with a remediation hint beats a hang.
    const unsupported = await sdkCommand('insertImage', { url: 'https://example.com/a.png' }, 'a.docx')
    expect(unsupported.status).toBe(501)
    const error = (await unsupported.json()) as { error: { code: string; message: string } }
    expect(error.error.code).toBe('WEB_UNSUPPORTED')
    expect(error.error.message).toContain('__GENOFFICE_COMMAND_SINK__')

    const nameless = await sdkCommand('', {}, 'a.docx')
    expect(nameless.status).toBe(400)
  })

  it('round-trips comments and validates their arguments', async () => {
    await bootHost()
    const added = await sdkCommand('addComment', { anchor: { range: { start: 0, end: 4 } }, text: 'typo' }, 'a.docx')
    expect(added.status).toBe(200)
    const addedBody = (await added.json()) as { result: { id: string } }
    const id = addedBody.result.id
    expect(typeof id).toBe('string')

    // An anchor is a location descriptor; `typeof [] === 'object'` let arrays
    // through and stored something every renderer reading `anchor.range` breaks on.
    expect((await sdkCommand('addComment', { anchor: [1, 2], text: 'x' }, 'a.docx')).status).toBe(400)
    expect((await sdkCommand('addComment', { anchor: { range: {} }, text: '' }, 'a.docx')).status).toBe(400)
    // A dangling parentId returns 200 upstream and creates a reply no thread UI
    // can resolve.
    expect(
      (await sdkCommand('addComment', { anchor: { cell: 'A1' }, text: 're', parentId: 'nope' }, 'a.docx')).status,
    ).toBe(404)

    const listed = await sdkCommand('listComments', {}, 'a.docx')
    const comments = (await listed.json()) as { ok: true; result: { comments: Array<Record<string, unknown>> } }
    expect(comments.result.comments).toHaveLength(1)
    expect(comments.result.comments[0]).toMatchObject({ text: 'typo', author: 'embed-session', resolved: false })

    expect((await sdkCommand('resolveComment', { id, resolved: true }, 'a.docx')).status).toBe(200)
    const open = (await (await sdkCommand('listComments', { resolved: false }, 'a.docx')).json()) as {
      result: { comments: unknown[] }
    }
    expect(open.result.comments).toHaveLength(0)

    expect((await sdkCommand('resolveComment', { id: 'missing' }, 'a.docx')).status).toBe(404)
    expect((await sdkCommand('removeComment', { id }, 'a.docx')).status).toBe(200)
    expect((await sdkCommand('removeComment', { id }, 'a.docx')).status).toBe(404)
  })

  it('requires a docId and scopes comments to it', async () => {
    await bootHost()
    expect((await sdkCommand('listComments', {})).status).toBe(400)

    await sdkCommand('addComment', { anchor: { slideId: 1 }, text: 'first' }, 'a.docx')
    await sdkCommand('addComment', { anchor: { slideId: 2 }, text: 'second' }, 'b.docx')
    const a = (await (await sdkCommand('listComments', {}, 'a.docx')).json()) as {
      result: { comments: Array<{ text: string }> }
    }
    expect(a.result.comments.map((c) => c.text)).toEqual(['first'])
  })

  it('snapshots, lists and restores real document bytes', async () => {
    await bootHost()
    const original = new TextEncoder().encode('version one')
    const path = host!.context.workspace.stageBytes('a.txt', original)

    const snapshot = (await (
      await sdkCommand('createSnapshot', { label: 'before edit' }, path)
    ).json()) as { ok: true; result: { id: string } }
    expect(snapshot.result.id).toBeTruthy()

    const listed = (await (await sdkCommand('listVersions', {}, path)).json()) as {
      ok: true
      result: { versions: Array<{ id: string; docId: string; sha256: string; size: number; message: string }> }
    }
    expect(listed.result.versions).toHaveLength(1)
    expect(listed.result.versions[0].message).toBe('before edit')
    expect(listed.result.versions[0].size).toBe(original.length)
    // Stores key on the basename, so the workspace path the caller used to
    // reach the file is never echoed back out.
    expect(listed.result.versions[0].docId).toBe('a.txt')
    expect(JSON.stringify(listed.result.versions[0])).not.toContain(tmpdir())

    host!.context.workspace.writeBytes(path, new TextEncoder().encode('version two'))
    expect(Buffer.from(host!.readFile(path)).toString()).toBe('version two')

    const restored = (await (
      await sdkCommand('restoreVersion', { versionId: snapshot.result.id }, path)
    ).json()) as { ok: true; result: { version: string } }
    expect(restored.result.version).toBeTruthy()
    expect(Buffer.from(host!.readFile(path)).toString()).toBe('version one')

    // A restore is itself a revision, so the host can confirm what it landed on.
    const after = (await (await sdkCommand('listVersions', {}, path)).json()) as {
      result: { versions: Array<{ id: string }> }
    }
    expect(after.result.versions.map((v) => v.id)).toContain(restored.result.version)

    expect((await sdkCommand('restoreVersion', { versionId: 'nope' }, path)).status).toBe(404)
    // A docId that resolves outside the workspace has no bytes to version.
    expect((await sdkCommand('createSnapshot', {}, '/etc/hosts')).status).toBe(400)
  })

  it('accumulates usage totals per host', async () => {
    await bootHost()
    await sdkCommand('reportUsage', { instanceId: 'ed_1', aiCalls: 2, docBytesWritten: 1024 }, 'a.docx')
    await sdkCommand('reportUsage', { instanceId: 'ed_1', aiCalls: 'nope' }, 'a.docx')
    await sdkCommand('reportUsage', { instanceId: 'ed_2', aiTokensIn: 50 }, 'a.docx')
    // Non-numeric fields coerce to 0 rather than poisoning the counter with NaN.
    expect(host!.context.embed.usage).toMatchObject({
      samples: 3,
      docBytesWritten: 1024,
      aiCalls: 2,
      aiTokensIn: 50,
    })
    expect(host!.context.embed.usage.instances).toEqual(['ed_1', 'ed_2'])
  })

  it('keeps comment state per host so two mounted editors do not share it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'office-ai-embed-two-'))
    for (const app of ['docs', 'sheets', 'slides', 'pdf']) {
      symlinkSync(join(RENDERER_ROOT, app, 'out', 'renderer'), join(root, app), 'dir')
    }
    const first = await startUiHost({ assetsDir: root, token: '' })
    const second = await startUiHost({ assetsDir: root, token: '' })
    try {
      const invoke = async (h: UiHostHandle, name: string, args: unknown, docId: string) => {
        const response = await fetch(`${h.url}/api/ipc/sdk%3Acommand`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ args: [{ name, args, docId }] }),
        })
        return (await response.json()) as { result: { comments: unknown[] } }
      }
      await invoke(first, 'addComment', { anchor: { cell: 'A1' }, text: 'only here' }, 'shared.docx')
      expect((await invoke(first, 'listComments', {}, 'shared.docx')).result.comments).toHaveLength(1)
      expect((await invoke(second, 'listComments', {}, 'shared.docx')).result.comments).toHaveLength(0)
    } finally {
      await first.close()
      await second.close()
    }
    expect(existsSync(root)).toBe(true)
  })
})
