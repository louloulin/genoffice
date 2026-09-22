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
///     \`setContent\` / \`insertText\` / \`updateTextBuffer\` so the app
///     can sync the buffer state into its own editor (tiptap, monaco, …).

import { installLiveModelSink, type SdkCommandSinkHandle } from './sdk-command-sink'

interface BufferState {
  text: string
  cursor: number
  bytes: number
}

type BufferListener = (state: BufferState) => void

class TextBuffer {
  private state: BufferState = { text: '', cursor: 0, bytes: 0 }
  private listeners = new Set<BufferListener>()

  getText(): string {
    return this.state.text
  }
  getBytes(): number {
    return this.state.bytes
  }
  getCursor(): number {
    return this.state.cursor
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
    this.state.text = text
    this.state.bytes = utf8Length(text)
    this.state.cursor = text.length
    for (const l of this.listeners) l(this.state)
  }
  insertAt(cursor: number, text: string): void {
    const before = this.state.text.slice(0, cursor)
    const after = this.state.text.slice(cursor)
    const merged = before + text + after
    this.state.text = merged
    this.state.bytes = utf8Length(merged)
    this.state.cursor = cursor + text.length
    for (const l of this.listeners) l(this.state)
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
}): SdkCommandSinkHandle {
  const buffer = resolveBuffer(options?.target)
  return installLiveModelSink({
    target: options?.target,
    adapter: {
      getText: () => buffer.getText(),
      getBytes: () => buffer.getBytes(),
      setText: (t) => buffer.replaceAll(t),
      insertText: (t) => buffer.insertAt(buffer.getCursor(), t),
    },
    extraHandlers: options?.extraHandlers,
  })
}
