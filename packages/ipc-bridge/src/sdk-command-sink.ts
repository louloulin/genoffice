/// Renderer-side command sink for the GenOffice embed bridge (sdk1.md §11.36).
///
/// The web-server bridge (apps/web-server/src/embed/bridge.ts) converts
/// inbound host SDK \`editor.command(name, args)\` envelopes into a call on
/// \`window.__GENOFFICE_COMMAND_SINK__\` when that function exists, and only
/// falls back to the server-backed \`POST /api/ipc/sdk:command\` channel when
/// it doesn't. That makes the sink the extension point for commands the
/// server cannot service — anything that needs the live editor model:
///
///   • \`openFileDialog\`        → browser file input + base64 payload
///   • \`print\`                 → window.print()
///   • \`setTheme\` / \`setLang\`   → push into the app's own UI state
///   • \`setContent\` / \`insertText\` → dispatch into the editor buffer
///   • \`mountSidebar\` / \`postToSidebar\` → plugin taskpane host
///
/// Rather than have every app re-implement the envelope plumbing, each
/// renderer calls \`installSdkCommandSink({ handlers })\` once during boot.
/// Handlers return a value (resolved into the command-result) or throw
/// (rejected, with \`err.code\` preserved on the wire).
///
/// Commands with no registered handler reject with \`code: 'UNSUPPORTED'\`
/// so the host sees a loud, actionable failure instead of a 30 s timeout.
///
/// Install order: AFTER the bridge script has booted (the bridge reads the
/// sink lazily on each command, so installing later is also fine) and
/// BEFORE the host's first \`editor.command()\` round-trip.

import { pickFileBytes, webPrint } from './web-native'

/** Shape of a sink handler. May be async and may throw. */
export type SdkCommandHandler = (args: unknown) => unknown | Promise<unknown>

export interface InstallSdkCommandSinkOptions {
  /**
   * Command name → handler. Names match the SDK's `EditorCommands` keys
   * (`openFileDialog`, `print`, `setContent`, …).
   */
  handlers: Record<string, SdkCommandHandler>
  /**
   * Optional sink target. Defaults to `globalThis.window`. Injectable for
   * tests running under a bare Node environment.
   */
  target?: SdkCommandSinkTarget
}

/** The subset of `window` the installer touches. */
export interface SdkCommandSinkTarget {
  __GENOFFICE_COMMAND_SINK__?: (name: string, args: unknown) => unknown
  [key: string]: unknown
}

export interface SdkCommandSinkHandle {
  /** Command names this sink can service (sorted). */
  supported: string[]
  /** Remove the sink (idempotent). Restores any previous sink. */
  uninstall(): void
  /** Dispatch one command directly (test / non-bridge helper). */
  dispatch(name: string, args: unknown): Promise<unknown>
}

/** Error thrown when a command has no registered handler. Carries the
 *  `code` the bridge forwards verbatim onto the command-result. */
export class UnsupportedCommandError extends Error {
  readonly code = 'UNSUPPORTED' as const
  constructor(name: string) {
    super(
      `sdk command "${name}" has no handler in this renderer; ` +
        `register it via installSdkCommandSink({ handlers: { ${name}: fn } })`,
    )
    this.name = 'UnsupportedCommandError'
  }
}

function resolveTarget(explicit?: SdkCommandSinkTarget): SdkCommandSinkTarget | null {
  if (explicit) return explicit
  // SAFETY: the DOM lib types `globalThis.window` as `Window & typeof
  // globalThis`, which has no index signature and so isn't structurally
  // assignable to our narrow target. We only read the one property the
  // sink writes, so the cast is sound; the `unknown` hop is required to
  // satisfy the compiler's overlap check.
  const g = globalThis as unknown as { window?: SdkCommandSinkTarget }
  return g.window ?? null
}

/**
 * Install the sink. Idempotent per target: calling twice replaces the
 * handler map but keeps one sink function installed (so a hot-reload
 * doesn't stack layers).
 */
export function installSdkCommandSink(
  options: InstallSdkCommandSinkOptions,
): SdkCommandSinkHandle {
  const target = resolveTarget(options.target)
  if (!target) {
    // No window (SSR / bare Node): return a no-op handle so callers don't
    // have to null-check. The dispatch helper still works for tests.
    return makeHandle({}, null, undefined)
  }
  const previous = target.__GENOFFICE_COMMAND_SINK__
  const sink = (name: string, args: unknown): unknown => {
    const handler = options.handlers[name]
    if (!handler) throw new UnsupportedCommandError(name)
    return handler(args)
  }
  target.__GENOFFICE_COMMAND_SINK__ = sink
  return makeHandle(options.handlers, target, previous)
}

function makeHandle(
  handlers: Record<string, SdkCommandHandler>,
  target: SdkCommandSinkTarget | null,
  previous: ((name: string, args: unknown) => unknown) | undefined,
): SdkCommandSinkHandle {
  let installed = true
  return {
    supported: Object.keys(handlers).sort(),
    dispatch(name, args) {
      const handler = handlers[name]
      if (!handler) return Promise.reject(new UnsupportedCommandError(name))
      return Promise.resolve()
        .then(() => handler(args))
    },
    uninstall() {
      if (!installed) return
      installed = false
      if (!target) return
      if (previous) target.__GENOFFICE_COMMAND_SINK__ = previous
      else delete target.__GENOFFICE_COMMAND_SINK__
    },
  }
}

/**
 * Ready-made `openFileDialog` handler (Kestrel M4). Wraps the browser
 * file input, converts each picked file to the SDK's `PickedFile` wire
 * shape (base64 payload + metadata), and returns `{canceled:true}` when
 * the user dismisses the dialog.
 *
 * Kept here (not in each app) so all six renderers ship the same
 * accept/multiple semantics.
 */
export function makeOpenFileDialogHandler(): SdkCommandHandler {
  return async (args: unknown) => {
    const a = (args ?? {}) as { accept?: string; multiple?: boolean }
    const picked = await pickFileBytes(a.accept, a.multiple === true)
    if (!picked || picked.length === 0) return { canceled: true }
    return {
      files: picked.map((file) => {
        const bytes = new Uint8Array(file.bytes)
        return {
          name: file.name,
          size: bytes.byteLength,
          // The browser File carries a MIME type, but `pickFileBytes`
          // only returns name + bytes (WebTempFile). Derive a coarse
          // type from the extension so hosts that branch on `type`
          // still get something useful; unknown → octet-stream.
          type: guessMimeType(file.name),
          lastModified: Date.now(),
          dataBase64: bytesToBase64(bytes),
        }
      }),
    }
  }
}

/** Base64-encode bytes without Buffer (the renderer bundle has no Node). */
export function bytesToBase64(bytes: Uint8Array): string {
  // Prefer the browser's btoa so we don't hand-roll base64. Chunk the
  // binary string so large files (a 10 MB deck) don't blow the argument
  // limit of String.fromCharCode.apply.
  if (typeof btoa === 'function') {
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    return btoa(binary)
  }
  // Node fallback (tests). Buffer is available there.
  const B = (globalThis as { Buffer?: typeof Buffer }).Buffer
  if (B) return B.from(bytes).toString('base64')
  throw new Error('no base64 encoder available in this environment')
}

/**
 * The renderer-servable command set that behaves the same in all six
 * apps. Returns a fresh handler map so callers can spread it and add
 * app-specific commands:
 *
 * ```ts
 * installSdkCommandSink({
 *   handlers: { ...defaultSdkCommandHandlers(), setTheme: (a) => applyTheme(a) },
 * })
 * ```
 *
 * Currently: `openFileDialog` (Kestrel M4 — browser file input) and
 * `print` (browser print dialog). Both are pure browser operations that
 * need no app state, which is why they can live here rather than in each
 * app's renderer.
 *
 * NOT included (need the live editor model, so each app wires them):
 * `setContent` / `getContent` / `insertText` / `insertImage` / `undo` /
 * `redo` / `setTheme` / `setLang` / `mountSidebar` / `postToSidebar`.
 */
export function defaultSdkCommandHandlers(): Record<string, SdkCommandHandler> {
  return {
    openFileDialog: makeOpenFileDialogHandler(),
    print: async () => {
      webPrint()
      return undefined
    },
  }
}

const MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
}

/** Coarse MIME guess from a filename extension. */
export function guessMimeType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}
