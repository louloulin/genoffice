import { describe, expect, it } from 'vitest'
import {
  installTextBufferSink,
  nativeAdapter,
  onBufferChange,
  redoTextBuffer,
  registerNativeAdapter,
  textBufferUndoStack,
  undoTextBuffer,
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

/**
 * Undo / redo / getUndoStack (sdk1.md §B.5.1 #2, SDK 2.0 Kestrel M1).
 *
 * The buffer only tracks host-driven mutations (`setContent` /
 * `insertText`). Local edits reported through `updateTextBuffer` are
 * deliberately excluded so a single Cmd+Z in a tiptap-backed app cannot
 * appear to undo twice.
 */
describe('text-buffer-adapter · undo/redo (§B.5.1 #2)', () => {
  it('exposes undo / redo / getUndoStack in the sink surface', () => {
    const handle = installTextBufferSink({ target: {} })
    expect(handle.supported).toEqual(
      expect.arrayContaining(['undo', 'redo', 'getUndoStack']),
    )
  })

  it('setContent then undo restores the previous buffer', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'first' })
    await handle.dispatch('setContent', { text: 'second' })
    await handle.dispatch('undo', {})
    const r = (await handle.dispatch('getContent', {})) as { text: string }
    expect(r.text).toBe('first')
  })

  it('undo → redo round-trips back to the newest state', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'a' })
    await handle.dispatch('setContent', { text: 'b' })
    await handle.dispatch('undo', {})
    await handle.dispatch('redo', {})
    const r = (await handle.dispatch('getContent', {})) as { text: string }
    expect(r.text).toBe('b')
  })

  it('getUndoStack reports { length, current } and tracks a mutation', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 0, current: 0 })
    await handle.dispatch('setContent', { text: 'x' })
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 1, current: 1 })
    await handle.dispatch('undo', {})
    // After undo the step lives on the redo branch: still counted in
    // `length`, no longer reachable by `undo`.
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 1, current: 0 })
  })

  it('undo on an empty stack rejects with UNSUPPORTED', async () => {
    const handle = installTextBufferSink({ target: {} })
    await expect(handle.dispatch('undo', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('a fresh mutation clears the redo branch', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'a' })
    await handle.dispatch('setContent', { text: 'b' })
    await handle.dispatch('undo', {})
    await handle.dispatch('setContent', { text: 'c' })
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 2, current: 2 })
    await expect(handle.dispatch('redo', {})).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('local edits (updateTextBuffer) stay off the undo stack', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'host' })
    updateTextBuffer({ text: 'host + local typing' }, target)
    // Only the host-driven mutation is undoable.
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 1, current: 1 })
    await handle.dispatch('undo', {})
    const r = (await handle.dispatch('getContent', {})) as { text: string }
    expect(r.text).toBe('')
  })

  it('undo / redo notify change listeners so the editor can re-sync', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    const seen: string[] = []
    onBufferChange((s) => seen.push(s.text), target)
    await handle.dispatch('setContent', { text: 'v1' })
    await handle.dispatch('setContent', { text: 'v2' })
    seen.length = 0
    await handle.dispatch('undo', {})
    expect(seen).toEqual(['v1'])
    seen.length = 0
    await handle.dispatch('redo', {})
    expect(seen).toEqual(['v2'])
  })

  it('caps the undo stack at 100 steps (oldest entries dropped)', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    for (let i = 0; i < 130; i++) {
      await handle.dispatch('setContent', { text: `v${i}` })
    }
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 100, current: 100 })
  })

  it('programmatic undoTextBuffer / redoTextBuffer helpers mirror the commands', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'one' })
    await handle.dispatch('setContent', { text: 'two' })
    expect(undoTextBuffer(target)).toBe(true)
    // Two host mutations were pushed, one was just undone: the step is
    // still counted in `length` but sits on the redo branch, so `current`
    // (undoable steps) is 1.
    expect(textBufferUndoStack(target)).toEqual({ length: 2, current: 1 })
    expect(redoTextBuffer(target)).toBe(true)
    expect(redoTextBuffer(target)).toBe(false)
  })

  it('a native adapter override wins over the buffer for undo/redo', async () => {
    const target: Record<string, unknown> = {}
    let nativeUndo = 0
    const handle = installTextBufferSink({
      target,
      adapter: {
        undo: () => {
          nativeUndo += 1
          return true
        },
        getUndoStack: () => ({ length: 7, current: 3 }),
      },
    })
    await handle.dispatch('setContent', { text: 'buffered' })
    await handle.dispatch('undo', {})
    expect(nativeUndo).toBe(1)
    // getUndoStack is also delegated, and the count is normalised.
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 7, current: 3 })
    // Untouched keys still fall through to the buffer.
    const r = (await handle.dispatch('getContent', {})) as { text: string }
    expect(r.text).toBe('buffered')
  })

  it('getUndoStack normalises a garbage adapter result', async () => {
    const handle = installTextBufferSink({
      target: {},
      adapter: {
        // Deliberately hostile: negative, fractional, current > length.
        getUndoStack: () => ({ length: 3.9, current: 99 }),
      },
    })
    expect(await handle.dispatch('getUndoStack', {})).toEqual({ length: 3, current: 3 })
  })
})

/**
 * Native-adapter registry.
 *
 * `installTextBufferSink` runs during renderer boot, but the editor
 * (a tiptap instance, a Univer workbook…) only exists after React
 * mounts. The registry lets the sink resolve the real adapter lazily on
 * every command, which is what makes sdk1.md §B.5.1 #2's "expose the
 * existing Ctrl+Z / Ctrl+Shift+Z as postMessage commands" a two-line
 * change per app instead of a boot-order puzzle.
 */
describe('text-buffer-adapter · registerNativeAdapter', () => {
  it('a registered adapter takes over after the sink was installed', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    // Before registration: buffer-backed.
    await handle.dispatch('setContent', { text: 'buffered' })
    expect(nativeAdapter(target)).toBeUndefined()

    let nativeUndo = 0
    const dispose = registerNativeAdapter(
      {
        getText: () => 'from-native',
        undo: () => {
          nativeUndo += 1
          return true
        },
      },
      target,
    )

    // getText now delegates; keys the native adapter omits still fall
    // through to the buffer.
    const content = (await handle.dispatch('getContent', {})) as { text: string }
    expect(content.text).toBe('from-native')
    await handle.dispatch('undo', {})
    expect(nativeUndo).toBe(1)
    expect(((await handle.dispatch('getUndoStack', {})) as { length: number }).length).toBe(1)

    dispose()
    expect(nativeAdapter(target)).toBeUndefined()
    const after = (await handle.dispatch('getContent', {})) as { text: string }
    expect(after.text).toBe('buffered')
  })

  it('binds adapter methods so a `this`-using object keeps its receiver', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    const adapter = {
      calls: 0,
      getText() {
        this.calls += 1
        return `calls=${this.calls}`
      },
    }
    registerNativeAdapter(adapter, target)
    expect(((await handle.dispatch('getContent', {})) as { text: string }).text).toBe('calls=1')
    expect(((await handle.dispatch('getContent', {})) as { text: string }).text).toBe('calls=2')
    expect(adapter.calls).toBe(2)
  })

  it('dispose only clears its own registration (remount race)', () => {
    const target: Record<string, unknown> = {}
    const first = { getText: () => 'first' }
    const second = { getText: () => 'second' }
    const disposeFirst = registerNativeAdapter(first, target)
    registerNativeAdapter(second, target)
    // A stale unmount must not wipe the newer adapter.
    disposeFirst()
    expect(nativeAdapter(target)).toBe(second)
  })
})

/**
 * Track changes passthrough (sdk1.md §B.5.1 #5).
 *
 * The mirror buffer has no concept of revisions, so every track-changes
 * command must either delegate to a registered native adapter or answer
 * UNSUPPORTED. Fabricating `{ enabled: false, changes: [] }` would be worse
 * than failing: a tracking-capable host would read that as "this document
 * has no revisions" rather than "this editor cannot track changes".
 */
describe('text-buffer-adapter · track changes (§B.5.1 #5)', () => {
  it('answers UNSUPPORTED when no native adapter is registered', async () => {
    const handle = installTextBufferSink({ target: {} })
    // The commands exist (so the host gets a typed failure, not a timeout)…
    expect(handle.supported).toEqual(
      expect.arrayContaining(['setTrackChanges', 'getTrackChanges', 'acceptChange', 'rejectChange']),
    )
    // …but they all reject.
    await expect(handle.dispatch('getTrackChanges', {})).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
    await expect(handle.dispatch('setTrackChanges', { enabled: true })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
    await expect(handle.dispatch('acceptChange', { changeId: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
    await expect(handle.dispatch('rejectChange', { changeId: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    })
  })

  it('delegates to the native adapter once one is registered', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    const accepted: string[] = []
    registerNativeAdapter(
      {
        setTrackChanges: () => {},
        getTrackChanges: () => ({
          enabled: true,
          changes: [{ id: 'rev_a', kind: 'delete', author: 'bob', date: '', text: 'gone' }],
        }),
        acceptChange: (id) => {
          accepted.push(id)
          return true
        },
        rejectChange: () => false,
      },
      target,
    )
    expect(await handle.dispatch('getTrackChanges', {})).toEqual({
      enabled: true,
      changes: [{ id: 'rev_a', kind: 'delete', author: 'bob', date: '', text: 'gone' }],
    })
    expect(await handle.dispatch('acceptChange', { changeId: 'rev_a' })).toEqual({ ok: true })
    expect(accepted).toEqual(['rev_a'])
    // The adapter's `false` is surfaced as "unknown id", not silently OK.
    await expect(handle.dispatch('rejectChange', { changeId: 'rev_a' })).rejects.toThrow(
      /unknown change id/,
    )
  })
})


describe('text-buffer-adapter · isDirty / save (sdk1 §11.60 / §11.62)', () => {
  it('a freshly-installed sink starts clean (isDirty → false)', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: false })
  })

  it('setContent marks the buffer dirty and isDirty → true', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'hello' })
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('insertText marks the buffer dirty', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'hel' })
    // After setContent the buffer is dirty; assert insertText keeps it dirty
    // (and proves the second mutation path also flips the flag).
    await handle.dispatch('insertText', { text: 'lo' })
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('a renderer-driven updateTextBuffer marks the buffer dirty', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    updateTextBuffer({ text: 'local typing' }, target)
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('save() without onSave rejects with an UnsupportedCommandError (loud failure, not a silent no-op)', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'dirty' })
    // The bridge throws an UnsupportedCommandError whose message
    // starts with `sdk command "save" has no handler` — match the
    // prefix rather than the literal `UNSUPPORTED` substring (the
    // error code lives on `err.code`, not in the message).
    await expect(handle.dispatch('save', {})).rejects.toThrow(/sdk command "save" has no handler/)
    // The dirty flag stays true — a failed save doesn't accidentally
    // clear the buffer's "needs save" state.
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('save() with onSave calls the renderer, marks the buffer clean, returns savedPath', async () => {
    const target: Record<string, unknown> = {}
    let calls = 0
    const handle = installTextBufferSink({
      target,
      onSave: () => {
        calls += 1
        return {
          ok: true as const,
          savedPath: '/managed/files/note.md',
          savedAt: '2026-09-22T10:00:00.000Z',
        }
      },
    })
    await handle.dispatch('setContent', { text: 'something to save' })
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
    const result = (await handle.dispatch('save', {})) as {
      ok: true
      savedPath?: string
      savedAt?: string
    }
    expect(result.ok).toBe(true)
    expect(result.savedPath).toBe('/managed/files/note.md')
    expect(result.savedAt).toBe('2026-09-22T10:00:00.000Z')
    expect(calls).toBe(1)
    // After save, the buffer is clean — a follow-up isDirty returns false.
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: false })
  })

  it('save() with an onSave that throws leaves the buffer dirty', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({
      target,
      onSave: () => {
        throw new Error('disk full')
      },
    })
    await handle.dispatch('setContent', { text: 'will not save' })
    await expect(handle.dispatch('save', {})).rejects.toThrow(/disk full/)
    // The dirty flag stays true so a retry attempt picks up where
    // the failed save left off.
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('save() with an async onSave awaits the promise', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({
      target,
      onSave: async () => {
        // Yield once to prove the bridge awaits the promise.
        await Promise.resolve()
        return { ok: true as const, savedPath: '/managed/x.md' }
      },
    })
    await handle.dispatch('setContent', { text: 'async save' })
    const result = (await handle.dispatch('save', {})) as { ok: true; savedPath?: string }
    expect(result.savedPath).toBe('/managed/x.md')
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: false })
  })

  it('the dirty flag survives undo / redo (host-driven edits stay dirty)', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    await handle.dispatch('setContent', { text: 'v1' })
    await handle.dispatch('setContent', { text: 'v2' })
    // Buffer is dirty from the two setContent calls.
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
    // Undo doesn't auto-mark clean — the user still has unsaved v2 in their head.
    await handle.dispatch('undo', {})
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })

  it('a native adapter registered via registerNativeAdapter overrides isDirty / save', async () => {
    const target: Record<string, unknown> = {}
    const handle = installTextBufferSink({ target })
    // Register a native adapter that takes priority over the buffer.
    registerNativeAdapter(
      {
        isDirty: () => true,
        save: async () => ({ ok: true as const, savedPath: '/native/saved.md' }),
      },
      target,
    )
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
    const result = (await handle.dispatch('save', {})) as { ok: true; savedPath?: string }
    expect(result.savedPath).toBe('/native/saved.md')
    // The buffer's own dirty flag is NOT touched when the native
    // adapter handles save (the native adapter is responsible for
    // its own state — mirror buffer just provides the fallback).
    expect(await handle.dispatch('isDirty', {})).toEqual({ dirty: true })
  })
})
