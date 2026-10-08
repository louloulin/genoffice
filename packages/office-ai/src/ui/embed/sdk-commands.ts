/**
 * Server-side dispatch for the SDK editor commands the embed bridge relays
 * (`POST /api/ipc/sdk:command` with `{args:[{name, args, docId}]}`).
 *
 * Why one multiplexed channel: renderer IPC channels (`comments:add`,
 * `files:list-versions`) and SDK command names (`addComment`, `listVersions`)
 * are different namespaces with different arg shapes. Funnelling through one
 * channel keeps the contracts from colliding and gives one place to see which
 * commands are actually host-backed.
 *
 * Of the 34 commands in `apps/sdk/src/types.ts` `EditorCommands`, only 8 are
 * host-backed. The other 26 mutate the live editor model or need a browser
 * dialog, and are serviced by the renderer's own `__GENOFFICE_COMMAND_SINK__`
 * — the bridge tries the sink first and only falls back here on an
 * `UNSUPPORTED` rejection. Reaching this dispatcher for one of those 26 means
 * the renderer never loaded or does not implement it, and the honest answer is
 * 501 with a remediation hint, not a hang.
 *
 * Storage differs from the web-server original by necessity: that one persists
 * comments and versions under `DATA_DIR` so a host that restarts still sees
 * them. A library host has no DATA_DIR and its workspace is a temp tree torn
 * down with the handle, so comments and the version index are per-host
 * in-memory. Version *payloads* are real bytes written into the workspace —
 * a snapshot restores an actual document, it is not a placeholder.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import type { Registry } from '../registry'
import type { Workspace } from '../workspace'

export const SDK_COMMAND_CHANNEL = 'sdk:command'

export interface SdkCommandRequest {
  name: string
  args?: unknown
  docId?: string
}

/**
 * An error whose `code` is one the SDK host already knows from the web-server
 * contract (`INVALID_ARGUMENT` / `NOT_FOUND` / `WEB_UNSUPPORTED`). The loopback
 * host maps those onto 400 / 404 / 501 in `ipc-errors.ts`, so a host written
 * against `apps/sdk` branches the same way whichever server is behind it.
 */
class SdkError extends Error {
  readonly code: string
  readonly channel: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SdkError'
    this.code = code
    this.channel = SDK_COMMAND_CHANNEL
  }
}

const invalid = (message: string): SdkError => new SdkError('INVALID_ARGUMENT', message)
const notFound = (message: string): SdkError => new SdkError('NOT_FOUND', message)
const unsupported = (message: string): SdkError => new SdkError('WEB_UNSUPPORTED', message)

// ----- comments --------------------------------------------------------------

export interface SdkComment {
  id: string
  author: string
  text: string
  anchor: unknown
  createdAt: number
  resolvedAt?: number
  resolved: boolean
  parentId?: string
}

export interface SdkVersionMeta {
  id: string
  docId: string
  index: number
  timestamp: number
  size: number
  sha256: string
  message?: string
}

export interface SdkUsageTotals {
  samples: number
  docBytesWritten: number
  aiCalls: number
  aiTokensIn: number
  aiTokensOut: number
  sessionDurationMs: number
  instances: string[]
}

export interface EmbedState {
  /** comments keyed by docId, newest last */
  comments: Map<string, SdkComment[]>
  /** version metadata keyed by docId, oldest first (index 0 is the oldest) */
  versions: Map<string, SdkVersionMeta[]>
  usage: SdkUsageTotals
}

/** Per-host state: two `startUiHost()` calls must not share comments. */
export function createEmbedState(): EmbedState {
  return {
    comments: new Map(),
    versions: new Map(),
    usage: {
      samples: 0,
      docBytesWritten: 0,
      aiCalls: 0,
      aiTokensIn: 0,
      aiTokensOut: 0,
      sessionDurationMs: 0,
      instances: [],
    },
  }
}

function commentsFor(state: EmbedState, key: string): SdkComment[] {
  let list = state.comments.get(key)
  if (!list) {
    list = []
    state.comments.set(key, list)
  }
  return list
}

export function addCommentCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): { id: string } {
  const { key } = docKey(workspace, req)
  const a = (req.args ?? {}) as { anchor?: unknown; text?: string; parentId?: string }
  if (!a.text || typeof a.text !== 'string') throw invalid('addComment requires a non-empty text')
  // An anchor is a location descriptor (`{range, cell, slideId, …}`), never an
  // indexed sequence. `typeof [] === 'object'`, so a plain typeof check accepts
  // arrays and stores something every renderer reading `anchor.range` breaks on.
  if (!a.anchor || typeof a.anchor !== 'object' || Array.isArray(a.anchor)) {
    throw invalid('addComment requires an anchor object')
  }
  const list = commentsFor(state, key)
  if (a.parentId !== undefined) {
    if (typeof a.parentId !== 'string' || a.parentId.length === 0) {
      throw invalid('parentId must be a non-empty string when provided')
    }
    // Existence check before insert: a dangling parentId returns 200 and creates
    // a reply no thread UI can resolve.
    if (!list.some((c) => c.id === a.parentId)) {
      throw notFound(`parent comment not found: ${a.parentId}`)
    }
  }
  const comment: SdkComment = {
    id: randomUUID(),
    // The bridge posts with the iframe's session header, not a bearer token, so
    // there is no verified identity to stamp. Hosts that need real attribution
    // own the comment channel themselves.
    author: 'embed-session',
    text: a.text,
    anchor: a.anchor,
    createdAt: Date.now(),
    resolved: false,
    ...(a.parentId ? { parentId: a.parentId } : {}),
  }
  list.push(comment)
  return { id: comment.id }
}

export function listCommentsCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): { comments: SdkComment[] } {
  const { key } = docKey(workspace, req)
  const a = (req.args ?? {}) as { resolved?: boolean; parentId?: string }
  let list = commentsFor(state, key)
  if (typeof a.resolved === 'boolean') list = list.filter((c) => c.resolved === a.resolved)
  if (typeof a.parentId === 'string') list = list.filter((c) => c.parentId === a.parentId)
  return { comments: list }
}

export function resolveCommentCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): undefined {
  const { key } = docKey(workspace, req)
  const a = (req.args ?? {}) as { id?: string; resolved?: boolean }
  if (!a.id || typeof a.id !== 'string') throw invalid('resolveComment requires an id')
  const comment = commentsFor(state, key).find((c) => c.id === a.id)
  if (!comment) throw notFound(`unknown comment id: ${a.id}`)
  const resolved = a.resolved !== false
  comment.resolved = resolved
  comment.resolvedAt = resolved ? Date.now() : undefined
  if (!resolved) delete comment.resolvedAt
  return undefined
}

export function removeCommentCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): undefined {
  const { key } = docKey(workspace, req)
  const a = (req.args ?? {}) as { id?: string }
  if (!a.id || typeof a.id !== 'string') throw invalid('removeComment requires an id')
  const list = commentsFor(state, key)
  const index = list.findIndex((c) => c.id === a.id)
  if (index === -1) throw notFound(`unknown comment id: ${a.id}`)
  list.splice(index, 1)
  return undefined
}

// ----- versions --------------------------------------------------------------

function versionsFor(state: EmbedState, key: string): SdkVersionMeta[] {
  let list = state.versions.get(key)
  if (!list) {
    list = []
    state.versions.set(key, list)
  }
  return list
}

function versionsDir(workspace: Workspace, key: string): string {
  return join(workspace.root, 'versions', key.replace(/[^\w.-]/g, '_'))
}

/**
 * Resolve an SDK `docId` to a workspace file. Mirrors the web-server's
 * FILES_DIR-relative resolution: the docId is either a path inside the
 * workspace or a name relative to its files dir, and anything that escapes the
 * workspace is refused.
 */
export function resolveDocPath(
  workspace: Workspace,
  docId: string,
): { ok: true; abs: string; key: string } | { ok: false; message: string } {
  if (!docId || typeof docId !== 'string') return { ok: false, message: 'docId is required' }
  const direct = workspace.resolvePath(docId)
  if (direct) return { ok: true, abs: direct, key: direct }
  // An absolute docId that missed the workspace root is an escape attempt.
  // Falling through to the filesDir join would reinterpret `/etc/hosts` as
  // `<filesDir>/etc/hosts` — still safely confined, but it downgrades a
  // rejected path into a plausible-looking "no document at …" 404.
  if (isAbsolute(docId)) return { ok: false, message: `docId resolves outside the office-ai workspace: ${docId}` }
  const relative = workspace.resolvePath(join(workspace.filesDir, docId))
  if (relative) return { ok: true, abs: relative, key: relative }
  return { ok: false, message: `docId does not resolve inside the office-ai workspace: ${docId}` }
}

/**
 * Resolve a request's docId to the absolute path plus the store key.
 *
 * The key is the *basename*, so `/embed/report.docx` and
 * `/embed/projects/q3/report.docx` reach one comment thread and one version
 * list instead of silently forking. A docId that names no workspace file still
 * yields a key — comments are pure metadata and do not need bytes — which is why
 * the unresolved branch falls back to the raw string rather than throwing.
 */
function docKey(workspace: Workspace, req: SdkCommandRequest): { abs: string | null; key: string } {
  const docId = req.docId
  if (!docId || typeof docId !== 'string') throw invalid('docId is required')
  const resolved = resolveDocPath(workspace, docId)
  return resolved.ok
    ? { abs: resolved.abs, key: basename(resolved.abs) }
    : { abs: null, key: basename(docId) }
}

export function listVersionsCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): { versions: SdkVersionMeta[] } {
  const { abs, key } = docKey(workspace, req)
  // A document with no file has no versions to list; answering an empty array
  // would read as "this document has never been snapshotted" rather than "you
  // pointed me at nothing".
  if (!abs) throw invalid(`docId does not resolve inside the office-ai workspace: ${req.docId}`)
  return { versions: versionsFor(state, key).map((v) => ({ ...v, docId: key })) }
}

export function createSnapshotCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): { id: string } {
  const { abs, key } = docKey(workspace, req)
  if (!abs) throw invalid(`docId does not resolve inside the office-ai workspace: ${req.docId}`)
  const a = (req.args ?? {}) as { label?: string }
  let bytes: Uint8Array
  try {
    bytes = workspace.readBytes(abs)
  } catch {
    throw notFound(`no document at ${req.docId}`)
  }
  const list = versionsFor(state, key)
  const meta: SdkVersionMeta = {
    id: randomUUID(),
    docId: key,
    index: list.length,
    timestamp: Date.now(),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    message: typeof a.label === 'string' && a.label ? a.label : 'manual snapshot',
  }
  const dir = versionsDir(workspace, key)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${meta.index}-${meta.id}.bin`), bytes)
  list.push(meta)
  return { id: meta.id }
}

/** Restore writes the snapshot's real bytes back over the document. */
export function restoreVersionCommand(
  state: EmbedState,
  workspace: Workspace,
  req: SdkCommandRequest,
): { version: string } {
  const { abs, key } = docKey(workspace, req)
  if (!abs) throw invalid(`docId does not resolve inside the office-ai workspace: ${req.docId}`)
  const a = (req.args ?? {}) as { versionId?: string }
  if (!a.versionId || typeof a.versionId !== 'string') throw invalid('restoreVersion requires a versionId')
  const list = versionsFor(state, key)
  const meta = list.find((v) => v.id === a.versionId)
  if (!meta) throw notFound(`unknown version id: ${a.versionId}`)
  const file = join(versionsDir(workspace, key), `${meta.index}-${meta.id}.bin`)
  let bytes: Uint8Array
  try {
    bytes = workspace.readBytes(file)
  } catch {
    throw notFound(`version payload missing for ${a.versionId}`)
  }
  workspace.writeBytes(abs, bytes)
  // The restore is itself a new revision, so the host can listVersions() and
  // see what it landed on rather than having to trust this one field.
  const restored: SdkVersionMeta = {
    id: randomUUID(),
    docId: key,
    index: list.length,
    timestamp: Date.now(),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    message: `restored ${meta.id}`,
  }
  const dir = versionsDir(workspace, key)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${restored.index}-${restored.id}.bin`), bytes)
  list.push(restored)
  return { version: restored.id }
}

// ----- telemetry -------------------------------------------------------------

export function reportUsageCommand(
  state: EmbedState,
  _workspace: Workspace,
  req: SdkCommandRequest,
): undefined {
  const a = (req.args ?? {}) as Record<string, unknown>
  const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  state.usage.samples += 1
  state.usage.docBytesWritten += num(a.docBytesWritten)
  state.usage.aiCalls += num(a.aiCalls)
  state.usage.aiTokensIn += num(a.aiTokensIn)
  state.usage.aiTokensOut += num(a.aiTokensOut)
  state.usage.sessionDurationMs += num(a.sessionDurationMs)
  const instanceId = a.instanceId
  if (typeof instanceId === 'string' && instanceId && !state.usage.instances.includes(instanceId)) {
    state.usage.instances.push(instanceId)
  }
  return undefined
}

// ----- dispatch --------------------------------------------------------------

/** The eight commands this host services; everything else is 501. */
export const SDK_COMMAND_TABLE: Record<
  string,
  (state: EmbedState, workspace: Workspace, req: SdkCommandRequest) => unknown
> = {
  addComment: addCommentCommand,
  listComments: listCommentsCommand,
  resolveComment: resolveCommentCommand,
  removeComment: removeCommentCommand,
  listVersions: listVersionsCommand,
  restoreVersion: restoreVersionCommand,
  createSnapshot: createSnapshotCommand,
  reportUsage: reportUsageCommand,
}

export function supportedSdkCommands(): string[] {
  return Object.keys(SDK_COMMAND_TABLE).sort()
}

/**
 * Register `sdk:command`. Errors propagate so `sendIpcErrorPayload` owns the
 * wire shape, matching every other channel — returning our own envelope here
 * would double-nest inside `{ok:true, result}`.
 */
export function registerSdkCommandHandlers(
  registry: Registry,
  workspace: Workspace,
  state: EmbedState,
): void {
  registry.registerHandle(SDK_COMMAND_CHANNEL, (_event: unknown, args: unknown) => {
    const request = (args ?? {}) as SdkCommandRequest
    if (!request || typeof request.name !== 'string' || !request.name) {
      throw invalid('command name is required')
    }
    const handler = SDK_COMMAND_TABLE[request.name]
    if (!handler) {
      throw unsupported(
        `command "${request.name}" is not host-backed; the renderer bundle services it via ` +
          'window.__GENOFFICE_COMMAND_SINK__',
      )
    }
    return handler(state, workspace, request)
  })
}
