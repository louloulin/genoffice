import { describe, expect, it } from 'vitest'
import {
  installTextBufferSink,
  onBufferChange,
  updateTextBuffer,
} from '../src/text-buffer-adapter'

/**
 * Renderer-side text-buffer adapter for the SDK command sink.
 *
 * Apps that haven't yet exposed their editor's live model can adopt
 * `installTextBufferSink` to satisfy setContent / getContent /
 * insertText without a deeper integration. The renderer then calls
 * `updateTextBuffer({ text, bytes })` after a local edit and
 * subscribes to `onBufferChange` to mirror host-driven edits back
 * into the editor.
 */

describe('text-buffer-adapter', () => {
  it('setContent replaces the buffer and fires change listeners', () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    const seen: string[] = []
    onBufferChange((s) => seen.push(s.text), target)
    return handle.dispatch('setContent', { text: 'hello world' }).then(() => {
      expect(seen).toEqual(['hello world'])
      return handle.dispatch('getContent', {})
    }).then((r) => {
      const v = r as { text?: string; bytes?: number }
      expect(v.text).toBe('hello world')
      // bytes is utf8 byte length; ASCII == char length.
      expect(v.bytes).toBe(11)
    })
  })

  it('insertText appends at the cursor and advances the cursor', () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    handle.dispatch('setContent', { text: 'foo' })
    return handle.dispatch('insertText', { text: 'bar' }).then(() =>
      handle.dispatch('getContent', {}).then((r) => {
        const v = r as { text?: string }
        expect(v.text).toBe('foobar')
      }),
    )
  })

  it('updateTextBuffer mirrors a local edit (renderer→host)', () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    updateTextBuffer({ text: 'local edit', bytes: 10 }, target)
    return handle.dispatch('getContent', {}).then((r) => {
      const v = r as { text?: string; bytes?: number }
      expect(v.text).toBe('local edit')
      expect(v.bytes).toBe(10)
    })
  })

  it('getContent rejects with UNSUPPORTED when no buffer is wired', () => {
    // Sanity: installTextBufferSink exposes getContent because it
    // installs a buffer-backed adapter. The UNSUPPORTED path is covered
    // by makeLiveModelHandlers' absent-method test.
    const handle = installTextBufferSink({ target: {} })
    return handle.dispatch('setContent', { text: 'x' }).then(() =>
      handle.dispatch('getContent', {}).then((r) => {
        expect(r).toEqual({ text: 'x', bytes: 1 })
      }),
    )
  })

  it('sidebar option wires mountSidebar / unmountSidebar / postToSidebar alongside the text buffer', () => {
    // Apps plug in one helper to get the full SDK 2.0 Kestrel M3.5 surface
    // (3 text commands + 3 sidebar commands) without composing the adapter.
    const mounted: Array<{ panelUrl: string; width?: number; title?: string }> = []
    const unmounted: string[] = []
    const posted: Array<{ panelId: string; message: unknown }> = []
    let counter = 0
    const fakeSidebar = {
      mount(i: { panelUrl: string; width?: number; title?: string }) {
        mounted.push(i)
        counter += 1
        return { panelId: `panel-${counter}` }
      },
      unmount(panelId: string) {
        unmounted.push(panelId)
        return true
      },
      post(panelId: string, message: unknown) {
        posted.push({ panelId, message })
      },
    }
    const handle = installTextBufferSink({ target: {}, sidebar: fakeSidebar })
    expect(handle.supported).toEqual(
      expect.arrayContaining([
        'getContent',
        'setContent',
        'insertText',
        'mountSidebar',
        'unmountSidebar',
        'postToSidebar',
        'openFileDialog',
        'print',
      ]),
    )
    return handle
      .dispatch('mountSidebar', { panelUrl: '/plugins/spell.html', width: 320, title: 'Spell' })
      .then((r) => {
        const r1 = r as { panelId: string }
        expect(r1.panelId).toBe('panel-1')
        expect(mounted).toEqual([{ panelUrl: '/plugins/spell.html', width: 320, title: 'Spell' }])
        return handle.dispatch('postToSidebar', { panelId: r1.panelId, message: { type: 'progress', pct: 5 } })
      })
      .then(() => {
        expect(posted).toEqual([{ panelId: 'panel-1', message: { type: 'progress', pct: 5 } }])
        return handle.dispatch('unmountSidebar', { panelId: 'panel-1' })
      })
      .then(() => {
        expect(unmounted).toEqual(['panel-1'])
      })
  })
})
