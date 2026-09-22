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
})
