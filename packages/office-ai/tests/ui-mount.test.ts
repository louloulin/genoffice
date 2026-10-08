/**
 * @vitest-environment jsdom
 *
 * The module under test only touches `document`/`window`, so the whole file
 * runs against vitest's jsdom environment. Stubbing `window` from inside a node
 * environment also replaces globals vitest itself reads, which deadlocks the
 * runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEmbedUrl, mountEditor, type MountedEditor } from '../src/ui-browser/mount'

const ENVELOPE_VERSION = '1.0'

let container: HTMLElement
let handle: MountedEditor | null = null

/**
 * jsdom gives the iframe a real `contentWindow`, but does not wire cross-frame
 * postMessage the way a browser does. The message pump is driven directly
 * instead — that is the part under test, and faking the transport would only
 * re-test jsdom.
 */
function fromEditor(h: MountedEditor, data: unknown, origin = 'http://127.0.0.1:9999'): void {
  const frame = h.iframe.contentWindow as unknown as MessageEventSource | null
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: frame! }))
}

function readyPayload(nonce?: string): unknown {
  return {
    v: ENVELOPE_VERSION,
    dir: 'editor→host',
    kind: 'event',
    payload: { name: 'ready', payload: { type: 'ready', app: 'docs', version: '0.1.0', ...(nonce ? { nonce } : {}) } },
  }
}

function commandResult(correlationId: string, payload: Record<string, unknown>): unknown {
  return { v: ENVELOPE_VERSION, dir: 'editor→host', kind: 'command-result', correlationId, payload }
}

function mount(overrides: Partial<Parameters<typeof mountEditor>[0]> = {}): MountedEditor {
  const editor = mountEditor({
    app: 'docs',
    baseUrl: 'http://127.0.0.1:9999',
    docId: 'report.docx',
    open: '/tmp/office-ai/report.docx',
    container,
    ...overrides,
  })
  // Spy on the frame's outbound postMessage so tests can read what the editor
  // sent without standing up a real cross-frame transport jsdom does not have.
  const frame = editor.iframe.contentWindow as unknown as Record<string, unknown>
  frame.postMessage = vi.fn()
  handle = editor
  return editor
}

/** Let queued microtasks run, so an `await ready` inside command() has posted. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

/** The correlationId of the single command the editor posted to its frame. */
function lastSent(): { name: string; args: unknown; correlationId: string } {
  const calls = sentMessages()
  const last = calls[calls.length - 1]
  expect(last).toBeDefined()
  return last
}

/** One recorded outbound call: the envelope, and the target origin. */
type SentEnvelope = { payload: { name: string; args: unknown }; correlationId: string }
type SentCall = [SentEnvelope, string]

function sentMessages(): Array<{ name: string; args: unknown; correlationId: string }> {
  const frame = handle!.iframe.contentWindow as unknown as { postMessage: { mock: { calls: SentCall[] } } }
  return frame.postMessage.mock.calls.map((call) => ({
    name: call[0].payload.name,
    args: call[0].payload.args,
    correlationId: call[0].correlationId,
  }))
}

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>'
  container = document.querySelector('#host') as HTMLElement
})

afterEach(() => {
  handle?.destroy()
  handle = null
})

describe('buildEmbedUrl', () => {
  it('encodes the docId and carries the presentation params', () => {
    const url = new URL(
      buildEmbedUrl({
        baseUrl: 'http://127.0.0.1:9999/',
        app: 'slides',
        docId: 'q3/report.pptx',
        open: '/tmp/office-ai/report.pptx',
        mode: 'view',
        theme: 'dark',
        lang: 'ja-JP',
        toolbar: 'minimal',
        nonce: 'n-1',
      }),
    )
    expect(url.pathname).toBe('/embed/q3%2Freport.pptx')
    expect(url.searchParams.get('app')).toBe('slides')
    expect(url.searchParams.get('open')).toBe('/tmp/office-ai/report.pptx')
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.searchParams.get('nonce')).toBe('n-1')
  })

  it('keeps a mount prefix and omits params the caller did not set', () => {
    const url = new URL(
      buildEmbedUrl({ baseUrl: 'http://host.test/office', app: 'pdf', docId: 'spec.pdf' }),
    )
    expect(url.pathname).toBe('/office/embed/spec.pdf')
    expect(url.searchParams.has('open')).toBe(false)
    expect(url.searchParams.has('token')).toBe(false)
  })

  // attachUi's same-origin mode is addressed as `baseUrl:'/office'`; `new URL()`
  // throws on that without a base, so resolving against the page is what keeps
  // the natural mode-B input working.
  it('resolves a same-origin relative baseUrl against the page', () => {
    const url = new URL(buildEmbedUrl({ baseUrl: '/office', app: 'docs', docId: 'a.docx' }))
    expect(url.origin).toBe(window.location.origin)
    expect(url.pathname).toBe('/office/embed/a.docx')
  })
})

describe('mountEditor', () => {
  it('mounts a full-size iframe at the embed URL', () => {
    const editor = mount()
    expect(container.querySelector('iframe')).toBe(editor.iframe)
    expect(editor.iframe.src).toContain('/embed/report.docx')
    expect(editor.iframe.style.height).toBe('100%')
    expect(editor.iframe.title).toContain('docs')
  })

  it('resolves whenReady on the bridge ready event', async () => {
    const editor = mount({ nonce: 'n-7' })
    const ready = editor.whenReady()
    fromEditor(editor, readyPayload('n-7'))
    await expect(ready).resolves.toMatchObject({ app: 'docs', nonce: 'n-7' })
  })

  it('fans one event out to every subscriber and unsubscribes cleanly', () => {
    const editor = mount()
    const first = vi.fn()
    const second = vi.fn()
    editor.on('saved', first)
    const off = editor.on('saved', second)
    fromEditor(editor, {
      v: ENVELOPE_VERSION,
      dir: 'editor→host',
      kind: 'event',
      payload: { name: 'saved', payload: { path: '/tmp/a.docx' } },
    })
    expect(first).toHaveBeenCalledWith({ path: '/tmp/a.docx' })
    expect(second).toHaveBeenCalledTimes(1)

    off()
    fromEditor(editor, {
      v: ENVELOPE_VERSION,
      dir: 'editor→host',
      kind: 'event',
      payload: { name: 'saved', payload: { path: '/tmp/b.docx' } },
    })
    expect(first).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('`once` fires a single time', () => {
    const editor = mount()
    const handler = vi.fn()
    editor.once('dirtyChanged', handler)
    const frame = {
      v: ENVELOPE_VERSION,
      dir: 'editor→host',
      kind: 'event',
      payload: { name: 'dirtyChanged', payload: { dirty: true } },
    }
    fromEditor(editor, frame)
    fromEditor(editor, frame)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('round-trips a command by correlationId', async () => {
    const editor = mount()
    fromEditor(editor, readyPayload())
    await editor.whenReady()

    const pending = editor.command('getContent')
    await flush()
    const sent = lastSent()
    expect(sent.name).toBe('getContent')

    fromEditor(editor, commandResult(sent.correlationId, { ok: true, result: { html: '<p>hi</p>' } }))
    await expect(pending).resolves.toEqual({ html: '<p>hi</p>' })
  })

  it('rejects a command with the error the iframe reported', async () => {
    const editor = mount()
    fromEditor(editor, readyPayload())
    const pending = editor.command('setMode', { mode: 'nope' })
    await flush()
    const sent = lastSent()
    fromEditor(
      editor,
      commandResult(sent.correlationId, { ok: false, error: { code: 'INVALID_MODE', message: 'unknown mode nope' } }),
    )
    await expect(pending).rejects.toMatchObject({ code: 'INVALID_MODE', message: 'unknown mode nope' })
  })

  it('waits for ready before posting, so a command sent during boot is not lost', async () => {
    const editor = mount()
    void editor.command('focus').catch(() => {})
    await flush()
    expect(sentMessages()).toHaveLength(0)

    fromEditor(editor, readyPayload())
    await flush()
    expect(lastSent().name).toBe('focus')
  })

  it('times a command out instead of awaiting forever', async () => {
    vi.useFakeTimers()
    try {
      const editor = mount({ readyTimeoutMs: 60_000 })
      fromEditor(editor, readyPayload())
      const pending = editor.command('exportPdf', {}, 50)
      const assertion = expect(pending).rejects.toMatchObject({ code: 'EMBED_COMMAND_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(60)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores traffic that is not from its own frame', async () => {
    const editor = mount()
    fromEditor(editor, readyPayload())
    // A different window: an unrelated page holding a reference to this one can
    // post at it, and a forged command-result would resolve a pending command
    // with an attacker-chosen value.
    const foreign = new MessageEvent('message', {
      data: commandResult('anything', { ok: true, result: 'forged' }),
      origin: 'http://evil.test',
      source: window as unknown as MessageEventSource,
    })
    window.dispatchEvent(foreign)
    await expect(editor.whenReady()).resolves.toBeDefined()
  })

  it('ignores malformed and wrongly-directed envelopes', () => {
    const editor = mount()
    const handler = vi.fn()
    editor.on('saved', handler)
    for (const data of [null, 'ready', 42, { v: '0.9', dir: 'editor→host', kind: 'event', payload: {} }]) {
      fromEditor(editor, data)
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('honours an origin allowlist', async () => {
    const editor = mount({ allowedOrigins: ['http://127.0.0.1:9999'] })
    const ready = editor.whenReady()
    fromEditor(editor, readyPayload(), 'http://evil.test')
    fromEditor(editor, readyPayload(), 'http://127.0.0.1:9999')
    await expect(ready).resolves.toBeDefined()
  })

  it('rejects whenReady on a boot error instead of running out the timeout', async () => {
    const editor = mount({ readyTimeoutMs: 60_000 })
    const ready = editor.whenReady()
    fromEditor(editor, {
      v: ENVELOPE_VERSION,
      dir: 'editor→host',
      kind: 'event',
      payload: { name: 'error', payload: { code: 'HANDSHAKE_FAILED', message: 'nonce mismatch' } },
    })
    await expect(ready).rejects.toMatchObject({ code: 'HANDSHAKE_FAILED' })
  })

  it('rejects whenReady when the frame never boots', async () => {
    vi.useFakeTimers()
    try {
      const editor = mount({ readyTimeoutMs: 1_000 })
      const assertion = expect(editor.whenReady()).rejects.toMatchObject({ code: 'EMBED_READY_TIMEOUT' })
      await vi.advanceTimersByTimeAsync(1_100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroy is idempotent, unmounts the iframe and rejects in-flight commands', async () => {
    const editor = mount()
    fromEditor(editor, readyPayload())
    const pending = editor.command('exportPdf', {}, 60_000)
    expect(container.querySelector('iframe')).not.toBeNull()

    editor.destroy()
    expect(container.querySelector('iframe')).toBeNull()
    await expect(pending).rejects.toMatchObject({ code: 'EDITOR_DESTROYED' })

    // A second destroy must not throw or reject twice.
    expect(() => editor.destroy()).not.toThrow()
    handle = null
  })

  it('refuses to post after destroy', async () => {
    const editor = mount()
    fromEditor(editor, readyPayload())
    await editor.whenReady()
    editor.destroy()
    handle = null
    await expect(editor.command('focus')).rejects.toMatchObject({ code: 'EDITOR_DESTROYED' })
    expect(() => editor.post('sidebarMessage', { text: 'hi' })).toThrow(/destroyed/)
  })

  it('reports a container selector that matches nothing', () => {
    expect(() => mount({ container: '#missing' })).toThrow(/no element matches/)
  })
})
