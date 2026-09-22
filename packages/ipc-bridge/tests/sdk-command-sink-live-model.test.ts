import { describe, expect, it } from 'vitest'
import {
  ExportFormatUnsupportedError,
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

  it('mountSidebar: forwards {panelUrl,width?,title?} and expects {panelId} from adapter', () => {
    let counter = 0
    const calls: Array<{ panelUrl: string; width?: number; title?: string }> = []
    const h = makeLiveModelHandlers({
      mountSidebar: (i) => { calls.push(i); counter += 1; return { panelId: 'panel-' + counter } },
    })
    const r1 = h.mountSidebar!({ panelUrl: '/plugins/spell.html', width: 320, title: 'Spell' })
    expect(r1).toEqual({ panelId: 'panel-1' })
    expect(calls).toEqual([{ panelUrl: '/plugins/spell.html', width: 320, title: 'Spell' }])
    const r2 = h.mountSidebar!({ panelUrl: 'https://plugins.example/ai' })
    expect(r2).toEqual({ panelId: 'panel-2' })
    expect(calls[1]).toEqual({ panelUrl: 'https://plugins.example/ai', width: undefined, title: undefined })
    expect(() => h.mountSidebar!({})).toThrow(/panelUrl is required/)
    expect(() => h.mountSidebar!({ panelUrl: '' })).toThrow(/panelUrl is required/)
    expect(() => h.mountSidebar!({ panelUrl: '/x', width: 'no' as unknown as number })).not.toThrow()
    // width/title are optional and silently dropped when wrong type — the SDK's
    // EditorCommands types already constrain them; the runtime just needs to
    // not blow up on a non-numeric width slipping through a misbehaving host.
  })

  it('mountSidebar: rejects adapters that fail to return a panelId', () => {
    const h = makeLiveModelHandlers({
      mountSidebar: () => undefined as unknown as { panelId: string },
    })
    expect(() => h.mountSidebar!({ panelUrl: '/x' })).toThrow(/panelId:string/)
    const h2 = makeLiveModelHandlers({
      mountSidebar: () => ({ panelId: '' }),
    })
    expect(() => h2.mountSidebar!({ panelUrl: '/x' })).toThrow(/panelId:string/)
  })

  it('unmountSidebar: forwards {panelId} to adapter', () => {
    const seen: string[] = []
    const h = makeLiveModelHandlers({
      unmountSidebar: (i) => { seen.push(i.panelId) },
    })
    h.unmountSidebar!({ panelId: 'panel-7' })
    expect(seen).toEqual(['panel-7'])
    expect(() => h.unmountSidebar!({})).toThrow(/panelId is required/)
    expect(() => h.unmountSidebar!({ panelId: '' })).toThrow(/panelId is required/)
  })

  it('postToSidebar: forwards {panelId,message} to adapter (no result wrapping)', () => {
    const seen: Array<{ panelId: string; message: unknown }> = []
    const h = makeLiveModelHandlers({
      postToSidebar: (i) => { seen.push(i) },
    })
    // postToSidebar is fire-and-forget at the SDK layer (Promise<void>);
    // the bridge must NOT wrap a synthetic {delivered:true} result — doing
    // so would silently change the SDK EditorCommands type contract.
    const r = h.postToSidebar!({ panelId: 'panel-7', message: { type: 'progress', pct: 5 } })
    expect(r).toBeUndefined()
    expect(seen).toEqual([{ panelId: 'panel-7', message: { type: 'progress', pct: 5 } }])
    expect(() => h.postToSidebar!({ message: { type: 'x' } })).toThrow(/panelId is required/)
  })

  it('SidebarPanelNotMountedError carries the SIDEBAR_PANEL_NOT_MOUNTED code', () => {
    const err = new SidebarPanelNotMountedError('ghost')
    expect(err.code).toBe('SIDEBAR_PANEL_NOT_MOUNTED')
    expect(err.name).toBe('SidebarPanelNotMountedError')
    expect(err.message).toContain('ghost')
  })

  it('adapter mountSidebar / unmountSidebar / postToSidebar absent => commands fall through to UNSUPPORTED', () => {
    const handle = installSdkCommandSink({
      handlers: makeLiveModelHandlers({}),
    })
    return Promise.all([
      handle.dispatch('mountSidebar', { panelUrl: '/x' }).then(
        () => { throw new Error('expected reject for mountSidebar') },
        (err: unknown) => { expect(err).toBeInstanceOf(UnsupportedCommandError) },
      ),
      handle.dispatch('unmountSidebar', { panelId: 'p' }).then(
        () => { throw new Error('expected reject for unmountSidebar') },
        (err: unknown) => { expect(err).toBeInstanceOf(UnsupportedCommandError) },
      ),
      handle.dispatch('postToSidebar', { panelId: 'p', message: {} }).then(
        () => { throw new Error('expected reject for postToSidebar') },
        (err: unknown) => { expect(err).toBeInstanceOf(UnsupportedCommandError) },
      ),
    ])
  })

  it('installLiveModelSink lists sidebar commands in supported when adapter exposes them', () => {
    const target: Record<string, unknown> = {}
    const handle = installLiveModelSink({
      target,
      adapter: {
        getText: () => 'x',
        mountSidebar: () => ({ panelId: 'p1' }),
        unmountSidebar: () => undefined,
        postToSidebar: () => undefined,
      },
    })
    expect(handle.supported).toEqual(
      expect.arrayContaining(['getContent', 'mountSidebar', 'unmountSidebar', 'postToSidebar']),
    )
  })
})


/**
 * Track changes (sdk1.md §B.5.1 #5).
 *
 * Four app-specific commands: setTrackChanges / getTrackChanges /
 * acceptChange / rejectChange. The sink must forward them verbatim when an
 * adapter implements them and answer `UNSUPPORTED` when it does not, so a
 * non-revision editor (sheets, slides) fails loudly instead of hanging.
 */
describe('sdk-command-sink · track changes (§B.5.1 #5)', () => {
  const emptyState = () => ({ enabled: false, changes: [] })

  it('registers all four commands when the adapter implements them', () => {
    const handle = installLiveModelSink({
      target: {},
      adapter: {
        setTrackChanges: () => {},
        getTrackChanges: emptyState,
        acceptChange: () => true,
        rejectChange: () => true,
      },
    })
    expect(handle.supported).toEqual(
      expect.arrayContaining(['setTrackChanges', 'getTrackChanges', 'acceptChange', 'rejectChange']),
    )
  })

  it('setTrackChanges forwards the boolean and returns { ok: true }', async () => {
    const seen: boolean[] = []
    const handle = installLiveModelSink({
      target: {},
      adapter: { setTrackChanges: (enabled) => seen.push(enabled) },
    })
    expect(await handle.dispatch('setTrackChanges', { enabled: true })).toEqual({ ok: true })
    expect(await handle.dispatch('setTrackChanges', { enabled: false })).toEqual({ ok: true })
    expect(seen).toEqual([true, false])
  })

  it('setTrackChanges rejects a non-boolean enabled', async () => {
    const handle = installLiveModelSink({
      target: {},
      adapter: { setTrackChanges: () => {} },
    })
    await expect(handle.dispatch('setTrackChanges', { enabled: 'yes' })).rejects.toThrow(
      /enabled must be a boolean/,
    )
    await expect(handle.dispatch('setTrackChanges', {})).rejects.toThrow(
      /enabled must be a boolean/,
    )
  })

  it('getTrackChanges returns the adapter state verbatim', async () => {
    const state = {
      enabled: true,
      changes: [{ id: 'rev_1', kind: 'insert' as const, author: 'alice', date: '2026-09-22', text: 'hi' }],
    }
    const handle = installLiveModelSink({
      target: {},
      adapter: { getTrackChanges: () => state },
    })
    expect(await handle.dispatch('getTrackChanges', {})).toEqual(state)
  })

  it('acceptChange / rejectChange forward the id and reject unknown ids', async () => {
    const accepted: string[] = []
    const rejected: string[] = []
    const handle = installLiveModelSink({
      target: {},
      adapter: {
        acceptChange: (id) => {
          if (id !== 'rev_known') return false
          accepted.push(id)
          return true
        },
        rejectChange: (id) => {
          rejected.push(id)
          return true
        },
      },
    })
    expect(await handle.dispatch('acceptChange', { changeId: 'rev_known' })).toEqual({ ok: true })
    expect(accepted).toEqual(['rev_known'])
    await expect(handle.dispatch('acceptChange', { changeId: 'rev_nope' })).rejects.toThrow(
      /unknown change id/,
    )
    expect(await handle.dispatch('rejectChange', { changeId: 'rev_x' })).toEqual({ ok: true })
    expect(rejected).toEqual(['rev_x'])
  })

  it('acceptChange rejects a missing / empty changeId', async () => {
    const handle = installLiveModelSink({
      target: {},
      adapter: { acceptChange: () => true, rejectChange: () => true },
    })
    await expect(handle.dispatch('acceptChange', {})).rejects.toThrow(/changeId is required/)
    await expect(handle.dispatch('acceptChange', { changeId: '' })).rejects.toThrow(
      /changeId is required/,
    )
    await expect(handle.dispatch('rejectChange', {})).rejects.toThrow(/changeId is required/)
  })

  it('an adapter without revision tracking leaves the commands unsupported', async () => {
    const handle = installLiveModelSink({
      target: {},
      adapter: { getText: () => 'x' },
    })
    expect(handle.supported).not.toContain('getTrackChanges')
    await expect(handle.dispatch('getTrackChanges', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })
})

/**
 * §B.5.1 #6 — `downloadAs`. The sink's job here is contract enforcement,
 * not export mechanics: an adapter that claims success without producing
 * a target (neither a blobUrl nor a path) must be reported as a failure,
 * because a host that receives `{ok:true}` will tell its user the export
 * succeeded and hand them nothing.
 */
describe('makeLiveModelHandlers — downloadAs', () => {
  it('is absent when the adapter has no exporter, so the host gets UNSUPPORTED', () => {
    // No handler is registered at all (the same shape as `undo` on an editor
    // without history). The sink then reports the standard
    // UnsupportedCommandError, which is the loud answer a host needs; an
    // empty `{blobUrl}` would have looked like a successful export.
    const h = makeLiveModelHandlers({ getText: () => 'x' })
    expect(h.downloadAs).toBeUndefined()
    const target = {}
    installSdkCommandSink({ target, handlers: h })
    const sink = (target as { __GENOFFICE_COMMAND_SINK__?: (n: string, a: unknown) => unknown })
      .__GENOFFICE_COMMAND_SINK__
    expect(() => sink!('downloadAs', { format: 'pdf' })).toThrow(UnsupportedCommandError)
  })

  it('defaults savePath to browser and normalises the result', async () => {
    const calls: Array<{ format: string; savePath: string; options?: Record<string, unknown> }> = []
    const h = makeLiveModelHandlers({
      downloadAs: (request) => {
        calls.push(request)
        return { blobUrl: 'blob:abc', size: 128 }
      },
    })
    const r = (await h.downloadAs!({ format: 'docx' })) as {
      ok: true
      blobUrl?: string
      path?: string
      size: number
      format: string
    }
    expect(calls).toEqual([{ format: 'docx', savePath: 'browser' }])
    expect(r).toEqual({ ok: true, blobUrl: 'blob:abc', size: 128, format: 'docx' })
  })

  it('passes a host-chosen path through and echoes it back', async () => {
    let seen = ''
    const h = makeLiveModelHandlers({
      downloadAs: (request) => {
        seen = request.savePath
        return { path: '/data/files/out.pdf', size: 55, format: 'pdf' }
      },
    })
    const r = (await h.downloadAs!({ format: 'pdf', savePath: '/data/files/out.pdf' })) as {
      path?: string
      blobUrl?: string
    }
    expect(seen).toBe('/data/files/out.pdf')
    expect(r.path).toBe('/data/files/out.pdf')
    // Exactly one target: a browser download and a written path are
    // mutually exclusive, and returning both would leave the host
    // guessing which one to advertise.
    expect(r.blobUrl).toBeUndefined()
  })

  it('rejects a missing format', async () => {
    const h = makeLiveModelHandlers({ downloadAs: () => ({ blobUrl: 'blob:x', size: 1 }) })
    await expect(h.downloadAs!({})).rejects.toThrow(/format is required/)
    await expect(h.downloadAs!({ format: '' })).rejects.toThrow(/format is required/)
  })

  it('rejects an adapter that reports success with no target', async () => {
    const h = makeLiveModelHandlers({
      downloadAs: () => ({ size: 42 }) as unknown as { blobUrl: string },
    })
    await expect(h.downloadAs!({ format: 'pdf' })).rejects.toThrow(/neither blobUrl nor path/)
  })

  it('rejects an adapter that omits the byte count', async () => {
    const h = makeLiveModelHandlers({
      downloadAs: () => ({ blobUrl: 'blob:x' }) as unknown as { blobUrl: string; size: number },
    })
    await expect(h.downloadAs!({ format: 'pdf' })).rejects.toThrow(/size:number/)
  })

  it('propagates a format-unsupported rejection without masking it', async () => {
    const h = makeLiveModelHandlers({
      downloadAs: () => {
        throw new ExportFormatUnsupportedError('pptx')
      },
    })
    await expect(h.downloadAs!({ format: 'pptx' })).rejects.toThrow(/cannot export to "pptx"/)
  })
})
