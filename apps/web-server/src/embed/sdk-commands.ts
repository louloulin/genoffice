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
 *      so we reject with `code: 'UNSUPPORTED'` + a remediation hint.
 *      The renderer bundle installs its own postMessage listener and
 *      services these before the bridge ever sees them; reaching this
 *      dispatcher means the renderer wasn't loaded or doesn't support
 *      the command yet.
 *
 *   3. **Telemetry** — `reportUsage`. The SDK aggregates usage
 *      client-side and posts it here so ops can scrape it alongside
 *      the DLQ metrics. Kept in a process-local counter (restart
 *      resets) mirroring the DLQ durability model.
 */
import { basename, join } from 'node:path'
import { registerHandle } from '../common/registry'
import { FILES_DIR, isManagedPath } from '../common/index'
import {
  addComment,
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

export interface SdkCommandSuccess {
  ok: true
  result: unknown
}

export interface SdkCommandFailure {
  ok: false
  error: { code: string; message: string }
}

export type SdkCommandResponse = SdkCommandSuccess | SdkCommandFailure

function fail(code: string, message: string): SdkCommandFailure {
  return { ok: false, error: { code, message } }
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

function handleAddComment(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { anchor?: CommentAnchor; text?: string; parentId?: string }
  if (!a.text || typeof a.text !== 'string') {
    return fail('INVALID_ARGUMENT', 'addComment requires a non-empty text')
  }
  if (!a.anchor || typeof a.anchor !== 'object') {
    return fail('INVALID_ARGUMENT', 'addComment requires an anchor object')
  }
  // Author is the embed session, not a trusted client identity — the
  // web-server has no JWT here (the bridge posts with the iframe's
  // session header, not a bearer token). Hosts that need real author
  // attribution should use `POST /api/v1/files/:id/comments` which
  // stamps `sub` from the verified JWT.
  const comment = addComment(resolved.key, {
    author: 'embed-session',
    text: a.text,
    anchor: a.anchor,
    ...(a.parentId ? { parentId: a.parentId } : {}),
  })
  return { ok: true, result: { id: comment.id } }
}

function handleListComments(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { resolved?: boolean; parentId?: string }
  const opts: { resolved?: boolean; parentId?: string } = {}
  if (typeof a.resolved === 'boolean') opts.resolved = a.resolved
  if (typeof a.parentId === 'string') opts.parentId = a.parentId
  return { ok: true, result: { comments: listComments(resolved.key, opts) } }
}

function handleResolveComment(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { id?: string; resolved?: boolean }
  if (!a.id || typeof a.id !== 'string') {
    return fail('INVALID_ARGUMENT', 'resolveComment requires an id')
  }
  const updated = resolveComment(resolved.key, a.id, a.resolved !== false)
  if (!updated) return fail('NOT_FOUND', `unknown comment id: ${a.id}`)
  return { ok: true, result: undefined }
}

function handleRemoveComment(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { id?: string }
  if (!a.id || typeof a.id !== 'string') {
    return fail('INVALID_ARGUMENT', 'removeComment requires an id')
  }
  const removed = removeComment(resolved.key, a.id)
  if (!removed) return fail('NOT_FOUND', `unknown comment id: ${a.id}`)
  return { ok: true, result: undefined }
}

// ─── Version commands ────────────────────────────────────────────────────────

function handleListVersions(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const versions = listVersions(resolved.key).map((v) => ({
    id: v.id,
    docId: v.docId,
    index: v.index,
    timestamp: v.timestamp,
    size: v.size,
    sha256: v.sha256,
    ...(v.message ? { message: v.message } : {}),
  }))
  return { ok: true, result: { versions } }
}

function handleRestoreVersion(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { versionId?: string }
  if (!a.versionId || typeof a.versionId !== 'string') {
    return fail('INVALID_ARGUMENT', 'restoreVersion requires a versionId')
  }
  const outcome = restoreVersion(resolved.key, a.versionId)
  if (!outcome.ok) return fail('RESTORE_FAILED', outcome.error ?? 'restore failed')
  // Return the id of the newest snapshot so the host can re-list and
  // confirm the restore landed (the restore itself captures a
  // pre-restore snapshot, so the newest version is always the
  // "just restored from" marker).
  const versions = listVersions(resolved.key)
  const newest = versions[versions.length - 1]
  return { ok: true, result: { version: newest?.id ?? a.versionId } }
}

function handleCreateSnapshot(req: SdkCommandRequest): SdkCommandResponse {
  const resolved = requireDoc(req)
  if ('error' in resolved) return resolved.error
  const a = (req.args ?? {}) as { label?: string }
  if (!existsSync(resolved.abs)) {
    return fail('NOT_FOUND', `file not found: ${resolved.key}`)
  }
  const bytes = readFileSync(resolved.abs)
  const meta = captureBeforeSave(resolved.key, bytes, a.label ?? 'manual snapshot')
  if (!meta) return fail('SNAPSHOT_FAILED', 'snapshot was not captured (empty file or unmanaged path)')
  return { ok: true, result: { id: meta.id } }
}

// ─── Telemetry ───────────────────────────────────────────────────────────────

function handleReportUsage(req: SdkCommandRequest): SdkCommandResponse {
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
  return { ok: true, result: undefined }
}

// ─── Dispatch table ──────────────────────────────────────────────────────────

function requireDoc(req: SdkCommandRequest): { ok: true; abs: string; key: string } | { error: SdkCommandFailure } {
  const resolved = resolveDocPath(req.docId ?? '')
  if (!resolved.ok) return { error: fail('INVALID_ARGUMENT', resolved.message) }
  return resolved
}

/**
 * Commands the web-server can service without a live editor model. Every
 * entry takes the parsed request and returns a `{ok, result|error}`
 * envelope. Anything not listed here rejects with `UNSUPPORTED` so the
 * host sees a loud, structured failure instead of a silent hang.
 *
 * Exported for tests + for the `supportedSdkCommands()` audit helper.
 */
export const SDK_COMMAND_TABLE: Record<string, (req: SdkCommandRequest) => SdkCommandResponse> = {
  addComment: handleAddComment,
  listComments: handleListComments,
  resolveComment: handleResolveComment,
  removeComment: handleRemoveComment,
  listVersions: handleListVersions,
  restoreVersion: handleRestoreVersion,
  createSnapshot: handleCreateSnapshot,
  reportUsage: handleReportUsage,
}

/** Command names this dispatcher can service (sorted). */
export function supportedSdkCommands(): string[] {
  return Object.keys(SDK_COMMAND_TABLE).sort()
}

/**
 * Pure dispatch — given a parsed request, return the response envelope.
 * Exported separately from the IPC registration so tests can exercise
 * the dispatch matrix without the HTTP layer.
 */
export function dispatchSdkCommand(request: SdkCommandRequest): SdkCommandResponse {
  if (!request || typeof request.name !== 'string' || !request.name) {
    return fail('INVALID_ARGUMENT', 'command name is required')
  }
  const handler = SDK_COMMAND_TABLE[request.name]
  if (!handler) {
    return fail(
      'UNSUPPORTED',
      `command "${request.name}" is not server-backed; the renderer bundle services it via its own postMessage listener`,
    )
  }
  try {
    return handler(request)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail('INTERNAL', message)
  }
}

/**
 * Register the `sdk:command` IPC channel. Called from
 * `apps/web-server/src/index.ts` at boot alongside the other
 * capability modules.
 */
export function registerSdkCommandHandlers(): void {
  registerHandle(SDK_COMMAND_CHANNEL, (_event: unknown, args: unknown) => {
    const request = (args ?? {}) as SdkCommandRequest
    return dispatchSdkCommand(request)
  })
}
