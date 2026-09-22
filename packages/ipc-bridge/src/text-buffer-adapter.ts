/// Renderer-side text buffer adapter for the SDK command sink.
///
/// A renderer (docs/sheets/slides/pdf/markdown/html) that does not yet
/// expose its own live-model adapter can use this module as a stop-gap:
/// \`installTextBufferSink\` installs the sink with a buffer-backed
/// adapter, and the renderer updates the buffer via
/// \`updateTextBuffer\` whenever the editor commits a change.
///
/// Contract:
///
///   - The host calls \`editor.command('setContent', { text })\`
///     → buffer.replaceAll(text) + buffer listeners fire \`'change'\`.
///   - The host calls \`editor.command('insertText', { text })\`
///     → buffer.insertAt(cursor, text) + cursor advances by \`text.length\`.
///   - The host calls \`editor.command('getContent')\`
///     → buffer.getText() + buffer.getBytes() (UTF-8 byte length).
///   - The renderer calls \`updateTextBuffer({ text, bytes })\` after a
///     local edit so \`getContent\` reflects the latest state without the
///     host needing to round-trip back through \`getContent\`.
///   - Listeners registered with \`onBufferChange\` run after every
///     \`setContent\` / \`insertText\` / \`updateTextBuffer\` / \`undoTextBuffer\`
///     / \`redoTextBuffer\` so the app can sync the buffer state into its
///     own editor (tiptap, monaco, …).
///   - The host calls \`editor.command('undo' | 'redo' | 'getUndoStack')\`
///     (sdk1.md §B.5.1 #2) → the buffer's own history, seeded only from
///     host-driven mutations. Local edits stay on the app's undo manager
///     so one Cmd+Z cannot appear to undo twice.

import { installLiveModelSink, type SdkCommandSinkHandle } from './sdk-command-sink'

interface BufferState {
  text: string
  cursor: number
  bytes: number
}

type BufferListener = (state: BufferState) => void

/** One reversible step: the snapshot taken *before* a mutation. */
interface UndoEntry {
  text: string
  cursor: number
}

/**
 * Undo stack depth. Matches the SDK contract in `apps/sdk/src/types.ts`
 * (`getUndoStack()` returns `{ length, current }`); 100 steps is the
 * usual editor default and keeps the memory cost bounded for large docs
 * (100 × doc size, so a 10 MB document caps at 1 GB worst case — in
 * practice the caller updates the buffer per keystroke cluster, not per
 * character, so the real depth rarely approaches the cap).
 */
const MAX_UNDO_DEPTH = 100

class TextBuffer {
  private state: BufferState = { text: '', cursor: 0, bytes: 0 }
  private listeners = new Set<BufferListener>()
  /** Snapshots *before* each reversible mutation, oldest first. */
  private past: UndoEntry[] = []
  /** Snapshots popped by `undo()`, newest first, for `redo()`. */
  private future: UndoEntry[] = []

  getText(): string {
    return this.state.text
  }
  getBytes(): number {
    return this.state.bytes
  }
  getCursor(): number {
    return this.state.cursor
  }
  /**
   * Snapshot the current state for the undo stack. Called before any
   * mutation the host can reverse (`setContent` / `insertText`).
   * Local edits reported through `updateTextBuffer` are *not* pushed
   * here — the app owns its own history for those (tiptap's undo
   * manager, Univer's command stack, …) and double-tracking would make
   * one Cmd+Z appear to undo twice.
   */
  private pushUndo(): void {
    this.past.push({ text: this.state.text, cursor: this.state.cursor })
    if (this.past.length > MAX_UNDO_DEPTH) this.past.shift()
    // A fresh mutation invalidates the redo branch.
    this.future.length = 0
  }

  /** Internal: called by \`updateTextBuffer\` after a local edit. */
  set({ text, bytes, cursor }: { text?: string; bytes?: number; cursor?: number }): void {
    if (typeof text === 'string') this.state.text = text
    if (typeof bytes === 'number') this.state.bytes = bytes
    else if (typeof text === 'string') this.state.bytes = utf8Length(text)
    if (typeof cursor === 'number') this.state.cursor = cursor
    for (const l of this.listeners) l(this.state)
  }
  replaceAll(text: string): void {
    this.pushUndo()
    this.state.text = text
    this.state.bytes = utf8Length(text)
    this.state.cursor = text.length
    for (const l of this.listeners) l(this.state)
  }
  insertAt(cursor: number, text: string): void {
    this.pushUndo()
    const before = this.state.text.slice(0, cursor)
    const after = this.state.text.slice(cursor)
    const merged = before + text + after
    this.state.text = merged
    this.state.bytes = utf8Length(merged)
    this.state.cursor = cursor + text.length
    for (const l of this.listeners) l(this.state)
  }
  /** Undo the last host-driven mutation. No-op (false) when empty. */
  undo(): boolean {
    const entry = this.past.pop()
    if (!entry) return false
    this.future.push({ text: this.state.text, cursor: this.state.cursor })
    this.state.text = entry.text
    this.state.bytes = utf8Length(entry.text)
    this.state.cursor = entry.cursor
    for (const l of this.listeners) l(this.state)
    return true
  }
  /** Redo the last undone mutation. No-op (false) when empty. */
  redo(): boolean {
    const entry = this.future.pop()
    if (!entry) return false
    this.past.push({ text: this.state.text, cursor: this.state.cursor })
    this.state.text = entry.text
    this.state.bytes = utf8Length(entry.text)
    this.state.cursor = entry.cursor
    for (const l of this.listeners) l(this.state)
    return true
  }
  /**
   * `{ length, current }` per the SDK contract: `length` is the total
   * number of steps in the combined past+future stack, `current` is how
   * many `undo()` calls remain (i.e. `past.length`).
   */
  undoStack(): { length: number; current: number } {
    return { length: this.past.length + this.future.length, current: this.past.length }
  }
  on(listener: BufferListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function utf8Length(text: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(text).length
  // Best-effort fallback (Node tests without DOM lib). Bytes != chars
  // for non-ASCII, but it's only used as a hint for \`getContent.bytes\`.
  return text.length
}

const SHARED_BUFFER_KEY = '__GENOFFICE_TEXT_BUFFER__' as const

interface BufferTarget {
  [SHARED_BUFFER_KEY]?: TextBuffer
  [key: string]: unknown
}

function resolveBuffer(target?: BufferTarget): TextBuffer {
  const t = target ?? ((globalThis as unknown as { window?: BufferTarget }).window ?? {})
  if (!t[SHARED_BUFFER_KEY]) {
    t[SHARED_BUFFER_KEY] = new TextBuffer()
  }
  return t[SHARED_BUFFER_KEY]!
}

/**
 * Update the shared text buffer (renderer-side, after a local edit so
 * subsequent \`getContent\` answers reflect the latest state).
 */
export function updateTextBuffer(
  input: { text?: string; bytes?: number; cursor?: number },
  target?: BufferTarget,
): void {
  resolveBuffer(target).set(input)
}

/**
 * Subscribe to text-buffer mutations (after a \`setContent\` /
 * \`insertText\` round-trip from the host).
 */
export function onBufferChange(listener: BufferListener, target?: BufferTarget): () => void {
  return resolveBuffer(target).on(listener)
}

/**
 * Undo the last host-driven buffer mutation (`setContent` / `insertText`).
 * Returns `true` when a step was rolled back, `false` when the stack was
 * already empty. Local edits are *not* on this stack — the app's own
 * undo manager owns those.
 */
export function undoTextBuffer(target?: BufferTarget): boolean {
  return resolveBuffer(target).undo()
}

/** Redo the last undone buffer mutation. Returns `false` when empty. */
export function redoTextBuffer(target?: BufferTarget): boolean {
  return resolveBuffer(target).redo()
}

/**
 * `{ length, current }` per the SDK contract — see
 * `apps/sdk/src/types.ts:getUndoStack`.
 */
export function textBufferUndoStack(target?: BufferTarget): { length: number; current: number } {
  return resolveBuffer(target).undoStack()
}

/**
 * Install the SDK command sink with a text-buffer-backed live-model
 * adapter. Apps that don't have their own editor model yet use this
 * to satisfy §11.36.5 setContent / getContent / insertText:
 *
 * ```ts
 * const handle = installTextBufferSink()
 * onBufferChange((s) => editorView.replace(s.text))
 * ```
 */
export function installTextBufferSink(options?: {
  target?: BufferTarget
  extraHandlers?: Record<string, (args: unknown) => unknown>
  /**
   * Native-editor overrides merged OVER the buffer-backed adapter.
   *
   * Use this when the app already owns the authoritative document model
   * (tiptap for docs, Univer for sheets, …): pass the editor's own
   * `getText` / `setText` / `undo` / `redo` / `getUndoStack` so host
   * commands drive the real editor instead of the mirror buffer. Keys
   * absent from this object fall through to the buffer implementation,
   * so an app can override just `undo` / `redo` and keep the buffer's
   * `setContent` / `getContent` round-trip.
   *
   * sdk1.md §B.5.1 #2 asks each renderer to expose its existing
   * Ctrl+Z / Ctrl+Shift+Z as postMessage commands — this is the hook
   * for that delegation.
   */
  adapter?: import('./sdk-command-sink').SdkLiveModelAdapter
  /**
   * Optional SidebarRuntime (from \`@genoffice/ipc-bridge/sidebar-runtime\`).
   * When present, \`mountSidebar / unmountSidebar / postToSidebar\` are
   * wired into the live-model adapter alongside the text buffer
   * commands so apps can drop in one helper and get the full
   * SDK 2.0 Kestrel M3.5 surface (setContent / getContent /
   * insertText + sidebar * 3) without composing the adapter manually.
   */
  sidebar?: SidebarRuntimeLike
}): SdkCommandSinkHandle {
  const buffer = resolveBuffer(options?.target)
  // The native adapter registered by the app (if any) is looked up on
  // every command rather than captured at install time, so the sink can
  // be installed during renderer boot — before React has mounted the
  // editor that owns `registerNativeAdapter`.
  const native = () => nativeAdapter(options?.target)
  const pick = <K extends keyof import('./sdk-command-sink').SdkLiveModelAdapter>(
    key: K,
    fallback: NonNullable<import('./sdk-command-sink').SdkLiveModelAdapter[K]>,
  ): NonNullable<import('./sdk-command-sink').SdkLiveModelAdapter[K]> => {
    const n = native()
    const fromNative = n?.[key]
    if (typeof fromNative === 'function') {
      // Bind to the adapter object so an app that writes
      // `{ undo() { return this.editor.undo() } }` keeps its `this`.
      return (fromNative as (...a: unknown[]) => unknown).bind(n) as NonNullable<
        import('./sdk-command-sink').SdkLiveModelAdapter[K]
      >
    }
    return fallback as NonNullable<import('./sdk-command-sink').SdkLiveModelAdapter[K]>
  }
  // exactOptionalPropertyTypes: true — strip undefined optional props
  // before delegating so monorepo tsconfigs don't trip TS2379.
  const base: {
    adapter: import('./sdk-command-sink').SdkLiveModelAdapter
    extraHandlers?: Record<string, (args: unknown) => unknown>
    target?: BufferTarget
  } = {
    adapter: {
      getText: () => pick('getText', () => buffer.getText())() as string | undefined,
      getBytes: () => pick('getBytes', () => buffer.getBytes())(),
      setText: (t) => pick('setText', (text: string) => buffer.replaceAll(text))(t),
      insertText: (t) => pick('insertText', (text: string) => buffer.insertAt(buffer.getCursor(), text))(t),
      undo: () => pick('undo', () => buffer.undo())(),
      redo: () => pick('redo', () => buffer.redo())(),
      getUndoStack: () => pick('getUndoStack', () => buffer.undoStack())(),
    },
  }
  if (options?.target !== undefined) base.target = options.target
  if (options?.extraHandlers !== undefined) base.extraHandlers = options.extraHandlers
  if (options?.adapter) {
    // Native-editor overrides win over the mirror buffer. Strip keys
    // whose value is `undefined` so exactOptionalPropertyTypes doesn't
    // trip and so a caller passing `{ undo: undefined }` doesn't erase
    // the buffer's implementation.
    const overrides = options.adapter
    const merged: typeof base.adapter = { ...base.adapter }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        ;(merged as Record<string, unknown>)[key] = value
      }
    }
    base.adapter = merged
  }
  if (options?.sidebar) {
    const sb = options.sidebar
    base.adapter = {
      ...base.adapter,
      mountSidebar: (i) => sb.mount(i),
      unmountSidebar: (i) => { sb.unmount(i.panelId); return undefined },
      postToSidebar: (i) => { sb.post(i.panelId, i.message); return undefined },
    }
  }
  return installLiveModelSink(base)
}

/**
 * Live native-adapter registry.
 *
 * `installTextBufferSink` runs at renderer boot, but the app's editor
 * (a tiptap instance, a Univer workbook, …) does not exist until React
 * has mounted. Rather than force every app to install the sink *after*
 * its editor is ready, the sink looks the adapter up lazily on every
 * command: an app calls `registerNativeAdapter(...)` from its editor
 * mount effect and the already-installed sink starts delegating.
 *
 * Precedence: a registered native adapter wins over the mirror buffer
 * for every key it defines. Keys it leaves out still fall through to
 * the buffer, so an app can register just `undo` / `redo` and keep the
 * buffer for `getContent`.
 *
 * This is the hook sdk1.md §B.5.1 #2 asks for — "每个编辑器的 renderer
 * 把现有键盘 Ctrl+Z / Ctrl+Shift+Z 公开成 postMessage 命令即可".
 */

/** Global key so the registry is shared across bundle instances. */
const NATIVE_ADAPTER_KEY = '__GENOFFICE_NATIVE_ADAPTER__' as const

interface NativeAdapterTarget {
  [NATIVE_ADAPTER_KEY]?: import('./sdk-command-sink').SdkLiveModelAdapter
  [key: string]: unknown
}

function nativeTarget(target?: BufferTarget): NativeAdapterTarget {
  return (target ?? ((globalThis as unknown as { window?: BufferTarget }).window ?? {})) as NativeAdapterTarget
}

/**
 * Register (or replace) the native-editor adapter for this renderer.
 * Call it from the editor's mount effect and dispose the returned
 * function on unmount — the sink then falls back to the buffer.
 *
 * Returns an unsubscribe function that only clears the registration if
 * it still points at the adapter you passed (so a fast unmount/remount
 * pair can't wipe the newer adapter).
 */
export function registerNativeAdapter(
  adapter: import('./sdk-command-sink').SdkLiveModelAdapter,
  target?: BufferTarget,
): () => void {
  const t = nativeTarget(target)
  t[NATIVE_ADAPTER_KEY] = adapter
  return () => {
    if (t[NATIVE_ADAPTER_KEY] === adapter) delete t[NATIVE_ADAPTER_KEY]
  }
}

/** Read the currently registered native adapter, if any (test helper). */
export function nativeAdapter(
  target?: BufferTarget,
): import('./sdk-command-sink').SdkLiveModelAdapter | undefined {
  return nativeTarget(target)[NATIVE_ADAPTER_KEY]
}

/**
 * Minimal structural type for the sidebar runtime — text-buffer-adapter
 * does not import sidebar-runtime.ts (that would be a cycle through
 * sdk-command-sink.ts). Apps pass the real instance; tests can mock it.
 */
export interface SidebarRuntimeLike {
  mount(input: { panelUrl: string; width?: number; title?: string }): { panelId: string }
  unmount(panelId: string): boolean
  post(panelId: string, message: unknown): void
}
