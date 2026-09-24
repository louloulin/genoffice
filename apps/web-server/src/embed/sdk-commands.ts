/**
 * Server-side dispatch for SDK editor commands relayed by the embed
 * bridge (sdk1.md §11.36).
 *
 * Background: the host SDK's `editor.command(name, args)` posts an
 * envelope to the embed iframe. The bridge (apps/web-server/src/embed/
 * bridge.ts) converts inbound `kind: 'command'` envelopes into a POST
 * to `/api/ipc/sdk:command` with `{args:[{name, args, docId}]}` and
 * mirrors the reply back as a `command-result`.
 *
 * Why a single channel and not one channel per command: the renderer
 * process owns channels like `comments:add` / `files:list-versions`
 * with their own arg shapes. SDK command names are a *different*
 * namespace (`addComment`, `listVersions`, …) with different args.
 * Multiplexing through `sdk:command` keeps the two contracts from
 * colliding and gives us one place to audit which SDK commands are
 * actually server-backed.
 *
 * Commands fall into three buckets:
 *
 *   1. **Server-backed here** — comments (`addComment` / `listComments`
 *      / `resolveComment` / `removeComment`), versions (`listVersions`
 *      / `restoreVersion` / `createSnapshot`). These have durable
 *      state in the web-server (`common/comments-store.ts`,
 *      `common/version-history.ts`) so a host that closes the browser
 *      and reopens the embed still sees them.
 *
 *   2. **Renderer-owned** — `setContent` / `insertText` / `undo` /
 *      `mountSidebar` / `openFileDialog` / … These mutate the live
 *      editor buffer or require a browser dialog. The web-server
 *      cannot service them (there is no live model in this process),
 *      so we reject with a structured error + a remediation hint.
 *      The renderer bundle installs its own postMessage listener and
 *      services these before the bridge ever sees them; reaching this
 *      dispatcher means the renderer wasn't loaded or doesn't support
 *      the command yet.
 *
 *   3. **Telemetry** — `reportUsage`. The SDK aggregates usage
 *      client-side and posts it here so ops can scrape it alongside
 *      the DLQ metrics. Kept in a process-local counter (restart
 *      resets) mirroring the DLQ durability model.
 *
 * Error contract: handlers return the RAW result and THROW typed
 * errors (`InvalidArgumentError` / `NotFoundError` /
 * `WebUnsupportedError`). The shared IPC dispatcher in
 * `apps/web-server/src/index.ts` already wraps the return value as
 * `{ok:true, result}` and serialises thrown errors as
 * `{error:{code, channel, reason}}` with the right HTTP status — so
 * returning our own envelope here would double-nest. `dispatchSdkCommand`
 * stays total (never throws) for the direct-call unit tests, but the
 * IPC handler lets the typed errors propagate so the wire shape
 * matches every other channel.
 */
import { basename, join } from 'node:path'
import { registerHandle } from '../common/registry'
import { FILES_DIR, isManagedPath } from '../common/index'
import { InvalidArgumentError, NotFoundError, WebUnsupportedError } from '../ai/errors'
import {
  addComment,
  getComment,
  listComments,
  removeComment,
  resolveComment,
  type CommentAnchor,
} from '../common/comments-store'
import {
  captureBeforeSave,
  listVersions,
  restoreVersion,
} from '../common/version-history'
import { existsSync, readFileSync } from 'node:fs'

/** Canonical IPC channel the bridge posts SDK commands to. */
export const SDK_COMMAND_CHANNEL = 'sdk:command'

/**
 * Args shape the bridge sends. `docId` comes from
 * `window.__GENOFFICE_EMBED__.docId` (the embed URL's `:docId` segment).
 */
export interface SdkCommandRequest {
  name: string
  args?: unknown
  docId?: string
}

/**
 * Resolve an SDK `docId` to the on-disk file path the version /
 * comment stores key on. The SDK sends whatever the embed URL carried
 * (`/embed/<docId>`), which may be a bare basename (`report.docx`) or
 * a path relative to FILES_DIR (`projects/q3/report.docx`). We accept
 * both, reject anything that escapes managed storage, and key the
 * stores on `basename` (matching every save pipeline in
 * `apps/web-server/src/{docs,sheets,slides,pdf,markdown,html}`).
 */
export function resolveDocPath(docId: string): { ok: true; abs: string; key: string } | { ok: false; message: string } {
  if (!docId || typeof docId !== 'string') {
    return { ok: false, message: 'docId is required' }
  }
  const abs = join(FILES_DIR, docId)
  if (!isManagedPath(abs)) {
    return { ok: false, message: `docId resolves outside managed storage: ${docId}` }
  }
  return { ok: true, abs, key: basename(abs) }
}

// ─── Telemetry aggregation (process-local, mirrors the DLQ model) ────────────

export interface UsageTotals {
  /** Number of `reportUsage` calls received. */
  samples: number
  /** Sum of `docBytesWritten` across every sample. */
  docBytesWritten: number
  /** Sum of `aiCalls` across every sample. */
  aiCalls: number
  /** Sum of `aiTokensIn` across every sample. */
  aiTokensIn: number
  /** Sum of `aiTokensOut` across every sample. */
  aiTokensOut: number
  /** Sum of `sessionDurationMs` across every sample. */
  sessionDurationMs: number
  /** Distinct instanceIds seen (bounded by a Set, not persisted). */
  instances: number
}

const usageTotals: UsageTotals = {
  samples: 0,
  docBytesWritten: 0,
  aiCalls: 0,
  aiTokensIn: 0,
  aiTokensOut: 0,
  sessionDurationMs: 0,
  instances: 0,
}
const usageInstances = new Set<string>()

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Snapshot the aggregated usage counters (test + metrics helper). */
export function getUsageTotals(): UsageTotals {
  return { ...usageTotals, instances: usageInstances.size }
}

/** Visible for tests. */
export function _resetUsageForTests(): void {
  usageTotals.samples = 0
  usageTotals.docBytesWritten = 0
  usageTotals.aiCalls = 0
  usageTotals.aiTokensIn = 0
  usageTotals.aiTokensOut = 0
  usageTotals.sessionDurationMs = 0
  usageInstances.clear()
}

// ─── Comment commands ────────────────────────────────────────────────────────

/** Throwing variant of `requireDoc` for the IPC path — the unit-test
 *  helper `dispatchSdkCommand` catches it and maps to an envelope. */
function requireDocOrThrow(req: SdkCommandRequest): { abs: string; key: string } {
  const resolved = resolveDocPath(req.docId ?? '')
  if (!resolved.ok) {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, resolved.message)
  }
  return resolved
}

export function addCommentCommand(req: SdkCommandRequest): { id: string } {
  const { key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { anchor?: CommentAnchor; text?: string; parentId?: string }
  if (!a.text || typeof a.text !== 'string') {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'addComment requires a non-empty text')
  }
  // §11.118: anchor must be a plain object — NOT an array. The old
  // `typeof a.anchor !== 'object'` check accepted arrays because
  // `typeof [] === 'object'`, but a comment anchor is conceptually a
  // location descriptor (`{ range, cell, slideId, ... }`), never an
  // indexed sequence. Storing an array would break downstream renderer
  // code that accesses named properties (`anchor.range`, `anchor.cell`,
  // `anchor.slideId`).
  if (!a.anchor || typeof a.anchor !== 'object' || Array.isArray(a.anchor)) {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'addComment requires an anchor object')
  }
  // sdk1 §11.122: parentId must be a non-empty string when provided,
  // and must point to an existing comment on the SAME file. The v1
  // REST endpoint closed this exact bug in §11.97 (orphan replies were
  // silently creating dangling pointers), but the SDK command path
  // skipped both validations: `addCommentCommand` spread `a.parentId`
  // verbatim into the store, so `parentId: 123`, `parentId: null`,
  // `parentId: ''`, `parentId: {x:1}`, `parentId: ['a','b']`, and
  // `parentId: 'cm_nonexistent'` all returned 200 + created a
  // dangling reply that no thread UI could resolve. Now reject
  // non-string / empty upfront and re-use `getComment` (already in
  // this module's import graph) for the existence check — same
  // pattern the v1 handler uses.
  if (a.parentId !== undefined) {
    if (typeof a.parentId !== 'string' || a.parentId.length === 0) {
      throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'parentId must be a non-empty string when provided')
    }
    const parent = getComment(key, a.parentId)
    if (!parent) {
      throw new NotFoundError(SDK_COMMAND_CHANNEL, `parent comment not found: ${a.parentId}`)
    }
  }
  // Author is the embed session, not a trusted client identity — the
  // bridge posts with the iframe's session header, not a bearer token,
  // so there is no verified `sub` to stamp. Hosts that need real author
  // attribution should use `POST /api/v1/files/:id/comments`, which
  // stamps the author from the verified JWT.
  const comment = addComment(key, {
    author: 'embed-session',
    text: a.text,
    anchor: a.anchor,
    ...(a.parentId ? { parentId: a.parentId } : {}),
  })
  return { id: comment.id }
}

export function listCommentsCommand(req: SdkCommandRequest) {
  const { key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { resolved?: boolean; parentId?: string }
  const opts: { resolved?: boolean; parentId?: string } = {}
  if (typeof a.resolved === 'boolean') opts.resolved = a.resolved
  if (typeof a.parentId === 'string') opts.parentId = a.parentId
  return { comments: listComments(key, opts) }
}

export function resolveCommentCommand(req: SdkCommandRequest): undefined {
  const { key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { id?: string; resolved?: boolean }
  if (!a.id || typeof a.id !== 'string') {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'resolveComment requires an id')
  }
  const updated = resolveComment(key, a.id, a.resolved !== false)
  if (!updated) throw new NotFoundError(SDK_COMMAND_CHANNEL, `unknown comment id: ${a.id}`)
  return undefined
}

export function removeCommentCommand(req: SdkCommandRequest): undefined {
  const { key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { id?: string }
  if (!a.id || typeof a.id !== 'string') {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'removeComment requires an id')
  }
  const removed = removeComment(key, a.id)
  if (!removed) throw new NotFoundError(SDK_COMMAND_CHANNEL, `unknown comment id: ${a.id}`)
  return undefined
}

// ─── Version commands ────────────────────────────────────────────────────────

export function listVersionsCommand(req: SdkCommandRequest) {
  const { key } = requireDocOrThrow(req)
  const versions = listVersions(key).map((v) => ({
    id: v.id,
    docId: v.docId,
    index: v.index,
    timestamp: v.timestamp,
    size: v.size,
    sha256: v.sha256,
    ...(v.message ? { message: v.message } : {}),
  }))
  return { versions }
}

export function restoreVersionCommand(req: SdkCommandRequest): { version: string } {
  const { key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { versionId?: string }
  if (!a.versionId || typeof a.versionId !== 'string') {
    throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'restoreVersion requires a versionId')
  }
  const outcome = restoreVersion(key, a.versionId)
  if (!outcome.ok) {
    // A missing snapshot is NOT_FOUND; a failed disk swap is a server
    // fault. The store reports both through the same envelope, so
    // branch on the message to pick the right status.
    const reason = outcome.error ?? 'restore failed'
    if (reason === 'version not found') throw new NotFoundError(SDK_COMMAND_CHANNEL, reason)
    throw new Error(reason)
  }
  // The restore itself captures a pre-restore snapshot, so the newest
  // version is always the "just restored from" marker. Return its id so
  // the host can re-list and confirm the restore landed.
  const versions = listVersions(key)
  const newest = versions[versions.length - 1]
  return { version: newest?.id ?? a.versionId }
}

export function createSnapshotCommand(req: SdkCommandRequest): { id: string } {
  const { abs, key } = requireDocOrThrow(req)
  const a = (req.args ?? {}) as { label?: string }
  if (!existsSync(abs)) {
    throw new NotFoundError(SDK_COMMAND_CHANNEL, `file not found: ${key}`)
  }
  const bytes = readFileSync(abs)
  const meta = captureBeforeSave(key, bytes, a.label ?? 'manual snapshot')
  if (!meta) {
    throw new Error('snapshot was not captured (empty file or unmanaged path)')
  }
  return { id: meta.id }
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

export function reportUsageCommand(req: SdkCommandRequest): undefined {
  const a = (req.args ?? {}) as Record<string, unknown>
  usageTotals.samples += 1
  usageTotals.docBytesWritten += num(a.docBytesWritten)
  usageTotals.aiCalls += num(a.aiCalls)
  usageTotals.aiTokensIn += num(a.aiTokensIn)
  usageTotals.aiTokensOut += num(a.aiTokensOut)
  usageTotals.sessionDurationMs += num(a.sessionDurationMs)
  if (typeof a.instanceId === 'string' && a.instanceId) {
    usageInstances.add(a.instanceId)
  }
  return undefined
}

// ─── Dispatch table ──────────────────────────────────────────────────────────

/**
 * Commands the web-server can service without a live editor model. Each
 * entry returns the RAW result the IPC layer wraps, or throws a typed
 * error the IPC layer serialises. Anything not listed rejects with a
 * structured `WEB_UNSUPPORTED` so the host sees a loud, actionable
 * failure instead of a silent hang.
 *
 * Exported for tests + for the `supportedSdkCommands()` audit helper.
 */
export const SDK_COMMAND_TABLE: Record<string, (req: SdkCommandRequest) => unknown> = {
  addComment: addCommentCommand,
  listComments: listCommentsCommand,
  resolveComment: resolveCommentCommand,
  removeComment: removeCommentCommand,
  listVersions: listVersionsCommand,
  restoreVersion: restoreVersionCommand,
  createSnapshot: createSnapshotCommand,
  reportUsage: reportUsageCommand,
}

/** Command names this dispatcher can service (sorted). */
export function supportedSdkCommands(): string[] {
  return Object.keys(SDK_COMMAND_TABLE).sort()
}

/** The two envelope shapes `dispatchSdkCommand` can return. Kept for
 *  the direct-call unit tests; the IPC path returns / throws the raw
 *  values so the shared dispatcher owns the wire envelope. */
export interface SdkCommandSuccess {
  ok: true
  result: unknown
}
export interface SdkCommandFailure {
  ok: false
  error: { code: string; message: string }
}
export type SdkCommandResponse = SdkCommandSuccess | SdkCommandFailure

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown })?.code
  return typeof code === 'string' ? code : 'INTERNAL'
}

/**
 * Total wrapper around the dispatch table: never throws, always returns
 * an envelope. Used by tests and by any caller that wants to inspect
 * failures without try/catch. The IPC handler below does NOT use this —
 * it lets typed errors propagate so `sendIpcError` produces the same
 * wire shape every other channel uses.
 */
export function dispatchSdkCommand(request: SdkCommandRequest): SdkCommandResponse {
  if (!request || typeof request.name !== 'string' || !request.name) {
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'command name is required' } }
  }
  const handler = SDK_COMMAND_TABLE[request.name]
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'WEB_UNSUPPORTED',
        message:
          `command "${request.name}" is not server-backed; the renderer bundle services it ` +
          'via its own postMessage listener (window.__GENOFFICE_COMMAND_SINK__)',
      },
    }
  }
  try {
    return { ok: true, result: handler(request) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: { code: errorCode(err), message } }
  }
}

/**
 * Register the `sdk:command` IPC channel. Called from
 * `apps/web-server/src/index.ts` at boot alongside the other
 * capability modules.
 *
 * Unlike `dispatchSdkCommand`, this handler lets typed errors
 * propagate so the shared `sendIpcError` classifier owns the wire
 * shape (status + `{error:{code, channel, reason}}`), matching every
 * other IPC channel. Unknown commands raise `WebUnsupportedError` →
 * HTTP 501.
 */
export function registerSdkCommandHandlers(): void {
  registerHandle(SDK_COMMAND_CHANNEL, (_event: unknown, args: unknown) => {
    const request = (args ?? {}) as SdkCommandRequest
    if (!request || typeof request.name !== 'string' || !request.name) {
      throw new InvalidArgumentError(SDK_COMMAND_CHANNEL, 'command name is required')
    }
    const handler = SDK_COMMAND_TABLE[request.name]
    if (!handler) {
      throw new WebUnsupportedError(SDK_COMMAND_CHANNEL, 'not implemented')
    }
    return handler(request)
  })
}
