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
 * `redo` / `getUndoStack` / `setTheme` / `setLang` / `mountSidebar` /
 * `postToSidebar` / `unmountSidebar` / `setTrackChanges` /
 * `getTrackChanges` / `acceptChange` / `rejectChange` / `downloadAs`.
 *
 * `undo` / `redo` / `getUndoStack` are part of `SdkLiveModelAdapter` as
 * of sdk1.md §B.5.1 #2, so any app wiring `installLiveModelSink` (or
 * `installTextBufferSink`) gets them for free.
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


/**
 * Adapter that bridges the SDK command sink to the live editor model.
 *
 * Each editor app (docs/sheets/slides/pdf/markdown/html) exposes a tiny
 * surface for SDK `editor.command(name, args)` round-trips that the
 * server-backed IPC channel cannot serve because it has no view of the
 * in-memory document:
 *
 *   • getText()           → current document text snapshot (for getContent)
 *   • getBytes()          → current document byte size (for getContent)
 *   • setText(text)       → replace the document text (setContent)
 *   • insertText(text)    → append to cursor / end of doc (insertText)
 *   • setTheme(theme)     → push the host's theme into the app's UI (setTheme)
 *   • setLang(lang)       → push the host's language into the app's i18n (setLang)
 *   • mountSidebar({panelUrl, width?, title?}) → mount a named
 *     taskpane panel by URL into the app sidebar (renderer adds an
 *     `<iframe src={panelUrl}>`); returns `{panelId}` so the host
 *     can later unmountSidebar / postToSidebar against the same
 *     panel. The `panelId` MUST be unique per mount call — the SDK
 *     treats it as opaque.
 *   • unmountSidebar({panelId}) → tear down a previously mounted
 *     panel. No-op (resolve ok) when the panelId is unknown — the
 *     caller may not know whether the panel was already torn down
 *     by a renderer crash.
 *   • postToSidebar({panelId, message}) → post a JSON-serialisable
 *     message to an already-mounted panel's iframe. Throws
 *     SidebarPanelNotMountedError (code SIDEBAR_PANEL_NOT_MOUNTED)
 *     when panelId is unknown so the host sees a structured failure
 *     instead of a silent drop.
 *   • undo() / redo() → roll the host-driven edit history back / forward
 *     one step; return `false` when the relevant stack is empty.
 *   • getUndoStack() → `{ length, current }` for the host's
 *     "can I undo?" button state (sdk1.md §B.5.1 #2).
 *
 * Apps that don't need one of these (e.g. a read-only preview) can omit
 * the corresponding method — the matching command then answers
 * `UnsupportedCommandError('UNSUPPORTED')` so the host gets a loud,
 * actionable failure rather than a 30 s timeout.
 */
export interface SdkLiveModelAdapter {
  getText?: () => string | undefined
  getBytes?: () => number | undefined
  setText?: (text: string) => void
  insertText?: (text: string) => void
  setTheme?: (theme: unknown) => void
  setLang?: (lang: string) => void
  /**
   * Mount a sidebar / taskpane panel. The adapter creates an
   * `<iframe src={panelUrl}>` (or equivalent), stores the panel
   * under a unique `panelId`, and returns that id so subsequent
   * `unmountSidebar` / `postToSidebar` calls can target the same
   * panel. The adapter MUST throw if `panelUrl` is not an absolute
   * http(s) URL or a same-origin path (defence-in-depth against
   * javascript: URIs and file: schemes).
   */
  mountSidebar?: (input: { panelUrl: string; width?: number; title?: string }) => { panelId: string }
  /**
   * Tear down a previously mounted panel. Adapter implementations
   * MUST be idempotent: tearing down an unknown panelId is a no-op.
   */
  unmountSidebar?: (input: { panelId: string }) => void
  /**
   * Post a JSON-serialisable message to a mounted panel's iframe.
   * The adapter MUST throw `SidebarPanelNotMountedError` when
   * `panelId` is unknown so the bridge can forward the typed error
   * onto the command-result envelope.
   */
  postToSidebar?: (input: { panelId: string; message: unknown }) => void
  /**
   * Undo the last host-driven edit (sdk1.md §B.5.1 #2). Returns
   * `true` when a step was rolled back and `false` when the undo stack
   * was already empty — the bridge maps `false` onto the SDK's
   * `UNSUPPORTED` rejection so the host can distinguish "nothing to
   * undo" from "this editor has no undo".
   *
   * Apps with a native editor (tiptap / Univer) should delegate to that
   * editor's own history and only fall back to the text-buffer history
   * when they don't track one.
   */
  undo?: () => boolean
  /** Redo the last undone edit. See `undo` for the `false` semantics. */
  redo?: () => boolean
  /** `{ length, current }` — see `apps/sdk/src/types.ts:getUndoStack`. */
  getUndoStack?: () => { length: number; current: number }
  /**
   * Return whether the editor's buffer has unsaved changes
   * (sdk1.md §11.60 / §11.62). Editors that don't track dirty state
   * omit this method — the bridge maps the omission onto
   * `UnsupportedCommandError('UNSUPPORTED')` so the host sees a loud,
   * actionable failure rather than a silent `false`.
   */
  isDirty?: () => boolean
  /**
   * Trigger the editor's native save pipeline (sdk1.md §11.60 / §11.62).
   * Resolves with the saved file's metadata matching the SDK's
   * `EditorCommands.save` contract (`{ ok: true; savedPath?; savedAt? }`).
   * Editors without a native save (e.g. PDF read-only viewer) omit this
   * method and the bridge surfaces `UnsupportedCommandError`.
   */
  save?: () =>
    | Promise<{ ok: true; savedPath?: string; savedAt?: string }>
    | { ok: true; savedPath?: string; savedAt?: string }
  /**
   * Revision / track-changes surface (sdk1.md §B.5.1 #5). Apps that
   * implement Word-style tracked changes (docs) expose the four
   * operations; apps without the concept omit them and the matching
   * command answers `UnsupportedCommandError('UNSUPPORTED')` so the
   * host sees a loud failure instead of a hang.
   */
  setTrackChanges?: (enabled: boolean) => void
  getTrackChanges?: () => {
    enabled: boolean
    changes: Array<{ id: string; kind: 'insert' | 'delete' | 'modify'; author: string; date: string; text: string }>
  }
  /** Accept one revision. Return `false` when the id is unknown. */
  acceptChange?: (changeId: string) => boolean
  /** Reject one revision. Return `false` when the id is unknown. */
  rejectChange?: (changeId: string) => boolean
  /**
   * Export the live document (sdk1.md §B.5.1 #6). Each app decides which
   * formats it can produce; the adapter reports the outcome so the sink
   * can tell "this editor can't export that" (`UNSUPPORTED`) apart from
   * "the export ran but failed" (a normal rejection).
   *
   * `savePath` is the host's request: `'browser'` means hand the bytes to
   * the browser as a download, any other string means write into managed
   * storage. The adapter is responsible for the actual mechanism.
   */
  downloadAs?: (request: {
    format: string
    savePath: 'browser' | string
    options?: Record<string, unknown>
  }) => Promise<DownloadAsResult> | DownloadAsResult
}

/** Result of a successful `downloadAs` export (§B.5.1 #6). */
export interface DownloadAsResult {
  /** Present for a browser download; revocable via `URL.revokeObjectURL`. */
  blobUrl?: string
  /** Present when the bytes landed in managed storage. */
  path?: string
  size: number
  /** Echoed back so the host can confirm which format it actually got. */
  format?: string
}

/**
 * Thrown by an adapter's `downloadAs` when the editor has no exporter for
 * the requested format. Distinct from a thrown `Error`, which the sink
 * reports as a genuine failure: "this editor can't emit pptx" is a
 * permanent answer, while "the export crashed" is not.
 */
export class ExportFormatUnsupportedError extends Error {
  readonly code = 'UNSUPPORTED' as const
  constructor(format: string) {
    super(`this editor cannot export to "${format}"`)
    this.name = 'ExportFormatUnsupportedError'
  }
}

/**
 * Error thrown by an adapter's `postToSidebar` when the named panel
 * has not been mounted yet. Carries `code` so the bridge forwards it
 * verbatim onto the command-result.
 */
export class SidebarPanelNotMountedError extends Error {
  readonly code = 'SIDEBAR_PANEL_NOT_MOUNTED' as const
  constructor(panel: string) {
    super(`sidebar panel "${panel}" has not been mounted yet; mountSidebar must run first`)
    this.name = 'SidebarPanelNotMountedError'
  }
}

/**
 * Build the live-model command handler map from an adapter. Each method
 * presence becomes a registered handler; absent methods fall back to
 * the standard `UnsupportedCommandError` so the host sees the missing
 * surface explicitly.
 */
export function makeLiveModelHandlers(
  adapter: SdkLiveModelAdapter,
): Record<string, SdkCommandHandler> {
  const handlers: Record<string, SdkCommandHandler> = {}
  if (adapter.getText || adapter.getBytes) {
    handlers.getContent = () => {
      const out: { text?: string; bytes?: number } = {}
      if (adapter.getText) {
        const t = adapter.getText()
        if (typeof t === 'string') out.text = t
      }
      if (adapter.getBytes) {
        const b = adapter.getBytes()
        if (typeof b === 'number') out.bytes = b
      }
      return out
    }
  }
  if (adapter.setText) {
    handlers.setContent = (args: unknown) => {
      const a = (args ?? {}) as { text?: unknown; html?: unknown }
      // Prefer text over html when both are present — html needs the
      // app's HTML importer which not every editor has. The text
      // round-trip is the universally-supported contract.
      const text = typeof a.text === 'string' ? a.text : (typeof a.html === 'string' ? a.html : null)
      if (text === null) throw new Error('setContent: args.text (or html) is required')
      adapter.setText!(text)
    }
  }
  if (adapter.insertText) {
    handlers.insertText = (args: unknown) => {
      const a = (args ?? {}) as { text?: unknown }
      if (typeof a.text !== 'string') throw new Error('insertText: args.text is required')
      adapter.insertText!(a.text)
    }
  }
  if (adapter.undo) {
    handlers.undo = () => {
      const ok = adapter.undo!()
      // `false` == the stack was empty. The SDK contract for `undo`
      // resolves `void` on success and rejects `UNSUPPORTED` when the
      // editor can't undo; an empty stack on an undo-capable editor is
      // the closest thing, so we reject.
      if (!ok) {
        throw new UnsupportedCommandError('undo')
      }
      return undefined
    }
  }
  if (adapter.redo) {
    handlers.redo = () => {
      const ok = adapter.redo!()
      if (!ok) {
        throw new UnsupportedCommandError('redo')
      }
      return undefined
    }
  }
  if (adapter.getUndoStack) {
    handlers.getUndoStack = () => {
      const stack = adapter.getUndoStack!()
      // Normalise so a buggy adapter can't hand the host NaN / negative
      // values that would break its "can I undo?" button state.
      const length = Number.isFinite(stack?.length) ? Math.max(0, Math.trunc(stack.length)) : 0
      const current = Number.isFinite(stack?.current) ? Math.max(0, Math.trunc(stack.current)) : 0
      return { length, current: Math.min(current, length) }
    }
  }
  if (adapter.isDirty) {
    // `isDirty()` returns the editor's current dirty state. The adapter
    // owns the source of truth — the host sees what the adapter decides
    // to expose, no fallback (so a renderer that hasn't wired this yet
    // gets `UnsupportedCommandError('UNSUPPORTED')` rather than a
    // misleading `false`).
    handlers.isDirty = () => {
      const d = adapter.isDirty!()
      // Pin the shape: an adapter that returns `undefined` / a non-boolean
      // gets coerced to `false` so a buggy renderer doesn't crash the
      // host. (The shape pin is on the SDK types side; this is the
      // bridge's defensive layer.)
      return { dirty: typeof d === 'boolean' ? d : false }
    }
  }
  if (adapter.save) {
    // `save()` triggers the adapter's native save pipeline. The adapter
    // returns `{ ok: true; savedPath?; savedAt? }` matching the SDK's
    // EditorCommands.save contract. Editors that haven't wired this
    // method get `UnsupportedCommandError('UNSUPPORTED')` at the
    // command boundary, matching the rest of the live-model surface.
    handlers.save = async () => {
      const r = await adapter.save!()
      // Normalise the result shape so a host SDK gets a consistent
      // contract regardless of which adapter supplied the save.
      const out: { ok: true; savedPath?: string; savedAt?: string } = { ok: true }
      if (r && typeof r === 'object') {
        if (typeof (r as { savedPath?: unknown }).savedPath === 'string') {
          out.savedPath = (r as { savedPath: string }).savedPath
        }
        if (typeof (r as { savedAt?: unknown }).savedAt === 'string') {
          out.savedAt = (r as { savedAt: string }).savedAt
        }
      }
      return out
    }
  }
  if (adapter.setTrackChanges) {
    handlers.setTrackChanges = (args: unknown) => {
      const a = (args ?? {}) as { enabled?: unknown }
      if (typeof a.enabled !== 'boolean') {
        throw new Error('setTrackChanges: args.enabled must be a boolean')
      }
      adapter.setTrackChanges!(a.enabled)
      return { ok: true as const }
    }
  }
  if (adapter.getTrackChanges) {
    handlers.getTrackChanges = () => adapter.getTrackChanges!()
  }
  if (adapter.acceptChange) {
    handlers.acceptChange = (args: unknown) => {
      const a = (args ?? {}) as { changeId?: unknown }
      if (typeof a.changeId !== 'string' || !a.changeId) {
        throw new Error('acceptChange: args.changeId is required')
      }
      if (!adapter.acceptChange!(a.changeId)) {
        throw new Error(`acceptChange: unknown change id: ${a.changeId}`)
      }
      return { ok: true as const }
    }
  }
  if (adapter.rejectChange) {
    handlers.rejectChange = (args: unknown) => {
      const a = (args ?? {}) as { changeId?: unknown }
      if (typeof a.changeId !== 'string' || !a.changeId) {
        throw new Error('rejectChange: args.changeId is required')
      }
      if (!adapter.rejectChange!(a.changeId)) {
        throw new Error(`rejectChange: unknown change id: ${a.changeId}`)
      }
      return { ok: true as const }
    }
  }
  if (adapter.setTheme) {
    handlers.setTheme = (args: unknown) => adapter.setTheme!(args)
  }
  if (adapter.setLang) {
    handlers.setLang = (args: unknown) => {
      const a = (args ?? {}) as { lang?: unknown }
      if (typeof a.lang !== 'string') throw new Error('setLang: args.lang is required')
      adapter.setLang!(a.lang)
    }
  }
  if (adapter.mountSidebar) {
    handlers.mountSidebar = (args: unknown) => {
      const a = (args ?? {}) as { panelUrl?: unknown; width?: unknown; title?: unknown }
      if (typeof a.panelUrl !== 'string' || !a.panelUrl) {
        throw new Error('mountSidebar: args.panelUrl is required')
      }
      // Conditionally spread rather than passing explicit `undefined`:
      // `exactOptionalPropertyTypes: true` (the monorepo default) rejects
      // `{ width: undefined }` for a `width?: number` parameter.
      const r = adapter.mountSidebar!({
        panelUrl: a.panelUrl,
        ...(typeof a.width === 'number' ? { width: a.width } : {}),
        ...(typeof a.title === 'string' ? { title: a.title } : {}),
      })
      if (!r || typeof r.panelId !== 'string' || !r.panelId) {
        throw new Error('mountSidebar: adapter must return {panelId:string}')
      }
      return { panelId: r.panelId }
    }
  }
  if (adapter.unmountSidebar) {
    handlers.unmountSidebar = (args: unknown) => {
      const a = (args ?? {}) as { panelId?: unknown }
      if (typeof a.panelId !== 'string' || !a.panelId) {
        throw new Error('unmountSidebar: args.panelId is required')
      }
      adapter.unmountSidebar!({ panelId: a.panelId })
      return undefined
    }
  }
  if (adapter.downloadAs) {
    handlers.downloadAs = async (args: unknown) => {
      const a = (args ?? {}) as { format?: unknown; savePath?: unknown; options?: unknown }
      if (typeof a.format !== 'string' || !a.format) {
        throw new Error('downloadAs: args.format is required')
      }
      // `'browser'` is the documented default for a host that omits savePath.
      const savePath = typeof a.savePath === 'string' && a.savePath ? a.savePath : 'browser'
      const request: {
        format: string
        savePath: 'browser' | string
        options?: Record<string, unknown>
      } = { format: a.format, savePath }
      if (a.options && typeof a.options === 'object') {
        request.options = a.options as Record<string, unknown>
      }
      const result = await adapter.downloadAs!(request)
      // Normalise: the SDK contract promises `{ok:true, size}` plus exactly
      // one of `blobUrl` / `path`. An adapter that returns neither has not
      // exported anything, and reporting success would be a silent lie.
      if (!result || typeof result.size !== 'number') {
        throw new Error('downloadAs: adapter must return {size:number}')
      }
      const hasTarget =
        (typeof result.blobUrl === 'string' && result.blobUrl.length > 0) ||
        (typeof result.path === 'string' && result.path.length > 0)
      if (!hasTarget) {
        throw new Error('downloadAs: adapter returned neither blobUrl nor path')
      }
      return {
        ok: true as const,
        ...(typeof result.blobUrl === 'string' && result.blobUrl ? { blobUrl: result.blobUrl } : {}),
        ...(typeof result.path === 'string' && result.path ? { path: result.path } : {}),
        size: result.size,
        format: typeof result.format === 'string' && result.format ? result.format : request.format,
      }
    }
  }
  if (adapter.postToSidebar) {
    handlers.postToSidebar = (args: unknown) => {
      const a = (args ?? {}) as { panelId?: unknown; message?: unknown }
      if (typeof a.panelId !== 'string' || !a.panelId) {
        throw new Error('postToSidebar: args.panelId is required')
      }
      adapter.postToSidebar!({ panelId: a.panelId, message: a.message })
      return undefined
    }
  }
  return handlers
}

/**
 * Convenience: install the sink with the default browser handlers
 * (`openFileDialog`, `print`) merged with a live-model adapter. Apps
 * that have a live editor call this once during boot:
 *
 * ```ts
 * installLiveModelSink({
 *   adapter: {
 *     getText: () => editorView.getText(),
 *     setText: (t) => editorView.replace(t),
 *     insertText: (t) => editorView.insertAtCursor(t),
 *   },
 * })
 * ```
 *
 * `extraHandlers` are merged last so an app can still register a
 * custom command (e.g. an editor-specific `applyTheme` that overrides
 * the adapter's `setTheme`) without losing the SDK defaults.
 */
export function installLiveModelSink(options: {
  adapter: SdkLiveModelAdapter
  extraHandlers?: Record<string, SdkCommandHandler>
  target?: SdkCommandSinkTarget
}): SdkCommandSinkHandle {
  // exactOptionalPropertyTypes: true treats `key: undefined` differently
  // from a missing key. Strip undefineds before delegating so apps with
  // `tsconfig.compilerOptions.exactOptionalPropertyTypes: true` (the
  // monorepo default) don't trip TS2379 here.
  const base: InstallSdkCommandSinkOptions = {
    handlers: {
      ...defaultSdkCommandHandlers(),
      ...makeLiveModelHandlers(options.adapter),
      ...(options.extraHandlers ?? {}),
    },
  }
  if (options.target !== undefined) base.target = options.target
  return installSdkCommandSink(base)
}
