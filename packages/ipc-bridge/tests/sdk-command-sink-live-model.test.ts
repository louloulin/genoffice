import { describe, expect, it } from 'vitest'
import {
  installLiveModelSink,
  installSdkCommandSink,
  makeLiveModelHandlers,
  SidebarPanelNotMountedError,
  UnsupportedCommandError,
  type SdkLiveModelAdapter,
} from '../src/sdk-command-sink'

/**
 * Adapter that lets apps wire up getContent / setContent / insertText /
 * setTheme / setLang in one shot (sdk1.md §11.36.5 follow-ups).
 *
 * The behaviour under test is the adapter itself — the per-app wiring
 * (docs/sheets/slides/pdf/markdown/html) lands in separate commits.
 */

describe('makeLiveModelHandlers / installLiveModelSink', () => {
  it('registers getContent only when adapter exposes text / bytes getters', () => {
    const a: SdkLiveModelAdapter = {
      getText: () => 'hello',
      getBytes: () => 5,
    }
    const h = makeLiveModelHandlers(a)
    expect(Object.keys(h).sort()).toEqual(['getContent'])
    const r = h.getContent({}) as { text?: string; bytes?: number }
    expect(r.text).toBe('hello')
    expect(r.bytes).toBe(5)
  })

  it('omits absent-method commands so they reject with UNSUPPORTED', () => {
    const h = makeLiveModelHandlers({})
    expect(h.getContent).toBeUndefined()
    expect(h.setContent).toBeUndefined()
    expect(h.insertText).toBeUndefined()
    expect(h.setTheme).toBeUndefined()
    expect(h.setLang).toBeUndefined()
    const handle = installSdkCommandSink({ handlers: h })
    return handle.dispatch('setContent', { text: 'x' }).then(
      () => { throw new Error('expected reject') },
      (err: unknown) => {
        expect(err).toBeInstanceOf(UnsupportedCommandError)
        expect((err as { code: string }).code).toBe('UNSUPPORTED')
      },
    )
  })

  it('setContent prefers args.text and falls back to args.html', () => {
    let captured: string | null = null
    const h = makeLiveModelHandlers({ setText: (t) => { captured = t } })
    h.setContent!({ text: 'plain' })
    expect(captured).toBe('plain')
    h.setContent!({ html: '<p>html</p>' })
    expect(captured).toBe('<p>html</p>')
    expect(() => h.setContent!({})).toThrow(/required/)
  })

  it('insertText throws when args.text is missing or wrong type', () => {
    let captured = ''
    const h = makeLiveModelHandlers({ insertText: (t) => { captured = t } })
    h.insertText!({ text: 'go' })
    expect(captured).toBe('go')
    expect(() => h.insertText!({})).toThrow(/required/)
    expect(() => h.insertText!({ text: 42 })).toThrow(/required/)
  })

  it('setTheme / setLang pass through', () => {
    let theme: unknown = null
    let lang = ''
    const h = makeLiveModelHandlers({
      setTheme: (t) => { theme = t },
      setLang: (l) => { lang = l },
    })
    h.setTheme!({ theme: 'dark' })
    expect(theme).toEqual({ theme: 'dark' })
    h.setLang!({ lang: 'zh-CN' })
    expect(lang).toBe('zh-CN')
    expect(() => h.setLang!({})).toThrow(/required/)
  })

  it('installLiveModelSink merges default + live-model + extra handlers', () => {
    let customCalled = false
    // Bare Node has no window — pass an explicit target so the sink
    // actually installs the merged handlers rather than the no-op
    // handle returned when `target` is null.
    const target: Record<string, unknown> = {}
    const handle = installLiveModelSink({
      target,
      adapter: {
        getText: () => 'live-text',
      },
      extraHandlers: {
        // Override theme defaults via extraHandlers
        custom: () => { customCalled = true; return 'ok' },
      },
    })
    expect(handle.supported).toEqual(
      expect.arrayContaining(['custom', 'getContent', 'openFileDialog', 'print']),
    )
    return Promise.all([
      handle.dispatch('getContent', {}).then((r) => {
        expect(r).toEqual({ text: 'live-text' })
      }),
      handle.dispatch('custom', {}).then(() => {
        expect(customCalled).toBe(true)
      }),
      // Sanity: the live-model handler was installed alongside the
      // defaults. We don't dispatch `openFileDialog` here because that
      // path uses DOM APIs (file input) not available under vitest's
      // bare Node; that contract is covered by
      // `tests/sdk-command-sink.test.ts`.
    ])
  })

  it('mountSidebar: html + url payloads are accepted, exactly-one is enforced', () => {
    const calls: Array<{ panel: string; html?: string; url?: string }> = []
    const h = makeLiveModelHandlers({
      mountSidebar: (i) => { calls.push(i) },
    })
    const r1 = h.mountSidebar!({ panel: 'spell-check', html: '<div>sc</div>' })
    expect(r1).toEqual({ panel: 'spell-check' })
    expect(calls).toEqual([{ panel: 'spell-check', html: '<div>sc</div>', url: undefined }])
    const r2 = h.mountSidebar!({ panel: 'ai-panel', url: 'https://plugins.example/ai' })
    expect(r2).toEqual({ panel: 'ai-panel' })
    expect(calls[1]).toEqual({ panel: 'ai-panel', html: undefined, url: 'https://plugins.example/ai' })
    expect(() => h.mountSidebar!({ panel: 'p' })).toThrow(/exactly one/)
    expect(() => h.mountSidebar!({ panel: 'p', html: 'x', url: 'y' })).toThrow(/exactly one/)
    expect(() => h.mountSidebar!({ html: 'x' })).toThrow(/panel is required/)
    expect(() => h.mountSidebar!({ panel: '', html: 'x' })).toThrow(/panel is required/)
  })

  it('postToSidebar: returns {panel, delivered:true} and forwards message', () => {
    const seen: Array<{ panel: string; message: unknown }> = []
    const h = makeLiveModelHandlers({
      postToSidebar: (i) => { seen.push(i) },
    })
    const r = h.postToSidebar!({ panel: 'spell-check', message: { type: 'progress', pct: 5 } })
    expect(r).toEqual({ panel: 'spell-check', delivered: true })
    expect(seen).toEqual([{ panel: 'spell-check', message: { type: 'progress', pct: 5 } }])
    expect(() => h.postToSidebar!({ message: { type: 'x' } })).toThrow(/panel is required/)
  })

  it('SidebarPanelNotMountedError carries the SIDEBAR_PANEL_NOT_MOUNTED code', () => {
    const err = new SidebarPanelNotMountedError('ghost')
    expect(err.code).toBe('SIDEBAR_PANEL_NOT_MOUNTED')
    expect(err.name).toBe('SidebarPanelNotMountedError')
    expect(err.message).toContain('ghost')
  })

  it('adapter mountSidebar / postToSidebar absent => command falls through to UNSUPPORTED', () => {
    const handle = installSdkCommandSink({
      handlers: makeLiveModelHandlers({}),
    })
    return Promise.all([
      handle.dispatch('mountSidebar', { panel: 'p', html: 'x' }).then(
        () => { throw new Error('expected reject for mountSidebar') },
        (err: unknown) => { expect(err).toBeInstanceOf(UnsupportedCommandError) },
      ),
      handle.dispatch('postToSidebar', { panel: 'p', message: {} }).then(
        () => { throw new Error('expected reject for postToSidebar') },
        (err: unknown) => { expect(err).toBeInstanceOf(UnsupportedCommandError) },
      ),
    ])
  })

  it('installLiveModelSink lists mountSidebar / postToSidebar in supported when adapter exposes them', () => {
    const target: Record<string, unknown> = {}
    const handle = installLiveModelSink({
      target,
      adapter: {
        getText: () => 'x',
        mountSidebar: () => undefined,
        postToSidebar: () => undefined,
      },
    })
    expect(handle.supported).toEqual(
      expect.arrayContaining(['getContent', 'mountSidebar', 'postToSidebar']),
    )
  })
})

