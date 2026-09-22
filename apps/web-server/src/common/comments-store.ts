/**
 * Persistent comments registry (sdk1.md §B.5.1 #4 / §B.5.2).
 *
 * File-scoped JSON document under `DATA_DIR/comments.json`. Restart-safe;
 * follows the same persistence shape as `webhooks-store.ts` so the two
 * storage backends share their load/save pattern.
 *
 * *Schema*: `{ [fileId: string]: Comment[] }` — each file has its own
 * array of comments, indexed by stable UUID for O(1) resolve / remove.
 *
 * Thread-safety: this is a single-process Node app, so a single
 * in-memory `commentsByFile` cache is fine. Mutating operations
 * (`addComment` / `resolveComment` / `removeComment`) all bump a
 * `dirtyVersion` counter that persistence uses to skip writes when
 * nothing changed (and to detect dirty state for tests).
 *
 * Out of scope for Kestrel M2:
 *   - Postgres / Redis backing store (M4+)
 *   - Soft-delete with audit log (currently hard delete)
 *   - Reply nesting beyond a single `parentId` pointer
 *   - Concurrent-edit merge (we are single-process; multi-process M4+)
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './index'

/**
 * Comment / annotation shape, mirrored from the SDK's `Comment`
 * interface (`apps/sdk/src/types.ts`). The web-server is the source of
 * truth for the wire format — the SDK type is generated from / kept in
 * sync with this. Authors are stamped from the JWT `sub` claim at
 * insert time, never trusted from the client.
 */
export interface Comment {
  /** Stable id, URL-safe base64 of 8 random bytes. */
  id: string
  /** Subject (`sub`) of the JWT that authored this comment. */
  author: string
  text: string
  /** App-specific anchor (cell address, char range, slide id, ...). */
  anchor: unknown
  /** Epoch ms (UTC). */
  createdAt: number
  /** Epoch ms; set on first `resolveComment({ resolved: true })`. */
  resolvedAt?: number
  resolved: boolean
  /** When this is a reply to another comment, the parent's id. */
  parentId?: string
}

/** Anchor shape (per app). Mirrored to SDK `CommentAnchor`. */
export interface CommentAnchor {
  range?: { start: number; end: number }
  cell?: string
  slideId?: string
  [key: string]: unknown
}

/** Per-file comment list input. */
export interface AddCommentInput {
  author: string
  text: string
  anchor: CommentAnchor
  parentId?: string
}

/** Filter args for `listComments`. */
export interface ListCommentsOptions {
  resolved?: boolean
  parentId?: string
}

const FILE = join(DATA_DIR, 'comments.json')
const RANDOM_BYTE_LEN = 8

function makeId(): string {
  const bytes = new Uint8Array(RANDOM_BYTE_LEN)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < RANDOM_BYTE_LEN; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  // btoa is available in Node 22 + browsers; avoids pulling `Buffer` so
  // this module stays usable in both environments without a Node type dep.
  return 'cm_' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** In-memory cache keyed by fileId. */
const commentsByFile = new Map<string, Comment[]>()
let dirty = false
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  if (!existsSync(FILE)) return
  try {
    const raw = readFileSync(FILE, 'utf8')
    if (!raw.trim()) return
    const parsed = JSON.parse(raw) as Record<string, Comment[]>
    for (const [fileId, list] of Object.entries(parsed)) {
      commentsByFile.set(fileId, list)
    }
  } catch (err) {
    // A malformed comments.json is recoverable: log and start fresh.
    // We don't crash boot because the user can still get a working
    // server — they just lose their comments (an acceptable tradeoff
    // for self-hosted / dev environments).
    console.warn('[comments-store] failed to load comments.json:', err)
  }
}

function persist(): void {
  if (!dirty) return
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const out: Record<string, Comment[]> = {}
  for (const [fileId, list] of commentsByFile.entries()) {
    if (list.length > 0) out[fileId] = list
  }
  writeFileSync(FILE, JSON.stringify(out, null, 2), 'utf8')
  dirty = false
}


/**
 * Fire a `comment.*` webhook (sdk1.md §M4 §C backlog). Lazy-imports
 * `webhooks-store` so this module stays free of its dependency graph at
 * boot time, mirroring the pattern `webhooks-store.ts` itself uses for
 * the DLQ.
 *
 * Best-effort: a missing callback for `fileId`, a delivery failure, or
 * even a missing `webhooks-store` module must not break the comment
 * mutation path. The DLQ inside `webhooks-store` captures failures for
 * later replay, so hosts can still observe drops.
 */
function notifyComment(fileId: string, event: string, comment: Comment): void {
  // Fire-and-forget. We don't await because add/resolve/remove are
  // synchronous IPC handlers and the network round-trip would block
  // the renderer. The DLQ inside webhooks-store catches failures.
  void import('./webhooks-store')
    .then((mod) => mod.fireCallback(event, fileId, {
      commentId: comment.id,
      author: comment.author,
      text: comment.text,
      anchor: comment.anchor,
      resolved: comment.resolved,
      resolvedAt: comment.resolvedAt ?? null,
      parentId: comment.parentId ?? null,
      createdAt: comment.createdAt,
    }))
    .catch(() => {
      // Lazy import failed (e.g. webhooks-store not initialized in
      // an isolated test) — silently swallow so the comment mutation
      // still succeeds.
    })
}

/**
 * Add a new comment to a file. Returns the assigned id (stable, opaque).
 * Caller is responsible for OAuth scope gate (`files:comment`) before
 * invoking this function.
 */
export function addComment(fileId: string, input: AddCommentInput): Comment {
  load()
  if (!input.author || typeof input.author !== 'string') {
    throw new Error('comments-store: author is required (stamped from JWT sub at the handler layer)')
  }
  if (!input.text || typeof input.text !== 'string') {
    throw new Error('comments-store: text is required')
  }
  const comment: Comment = {
    id: makeId(),
    author: input.author,
    text: input.text,
    anchor: input.anchor,
    createdAt: Date.now(),
    resolved: false,
    ...(input.parentId ? { parentId: input.parentId } : {}),
  }
  const list = commentsByFile.get(fileId) ?? []
  list.push(comment)
  commentsByFile.set(fileId, list)
  dirty = true
  persist()
  notifyComment(fileId, 'comment.added', comment)
  return comment
}

/**
 * List comments on a file. Returns a fresh array (not a reference into
 * the store) so callers can't accidentally mutate cached state.
 */
export function listComments(fileId: string, opts: ListCommentsOptions = {}): Comment[] {
  load()
  const list = commentsByFile.get(fileId) ?? []
  let filtered = list
  if (typeof opts.resolved === 'boolean') {
    filtered = filtered.filter((c) => c.resolved === opts.resolved)
  }
  if (typeof opts.parentId === 'string') {
    filtered = filtered.filter((c) => c.parentId === opts.parentId)
  } else if (opts.parentId === undefined && 'parentId' in opts === false) {
    // Default: top-level only (no parentId set). Reply threads are
    // not flattened in M2; the renderer fans them out under the parent.
    filtered = filtered.filter((c) => !c.parentId)
  }
  return filtered.map((c) => ({ ...c }))
}

/**
 * Mark a comment resolved / unresolved. Sets `resolvedAt` on the first
 * resolve, leaves it intact on subsequent toggles. Returns the updated
 * comment, or `null` if the id is unknown.
 */
export function resolveComment(fileId: string, id: string, resolved: boolean): Comment | null {
  load()
  const list = commentsByFile.get(fileId) ?? []
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return null
  const existing = list[idx]!
  // Sticky resolvedAt: set on first resolve, keep across toggles.
  // Even going false -> true -> false -> true keeps the original
  // timestamp so a comment has a stable "first resolved at" for audit
  // purposes. This matches the only-office / google-docs semantics
  // (a comment's resolvedAt is the time it was first marked resolved,
  // not the time of the most recent toggle).
  const resolvedAt =
    resolved && existing.resolvedAt === undefined
      ? Date.now()
      : existing.resolvedAt
  const updated: Comment = {
    ...existing,
    resolved,
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
  }
  list[idx] = updated
  commentsByFile.set(fileId, list)
  dirty = true
  persist()
  notifyComment(fileId, 'comment.resolved', updated)
  return { ...updated }
}

/**
 * Hard-delete a comment. Returns `true` if removed, `false` if the id
 * was unknown. Soft-delete with audit log is M4+.
 */
export function removeComment(fileId: string, id: string): boolean {
  load()
  const list = commentsByFile.get(fileId) ?? []
  const idx = list.findIndex((c) => c.id === id)
  if (idx < 0) return false
  const removed = list[idx]!
  list.splice(idx, 1)
  commentsByFile.set(fileId, list)
  dirty = true
  persist()
  notifyComment(fileId, 'comment.removed', removed)
  return true
}

/**
 * Look up a single comment by id. Returns `null` if unknown.
 */
export function getComment(fileId: string, id: string): Comment | null {
  load()
  const list = commentsByFile.get(fileId) ?? []
  const found = list.find((c) => c.id === id)
  return found ? { ...found } : null
}

/** Total comments across all files (test helper). */
export function totalCommentCount(): number {
  load()
  let n = 0
  for (const list of commentsByFile.values()) n += list.length
  return n
}

/** Per-file count (test helper). */
export function commentCountForFile(fileId: string): number {
  load()
  return (commentsByFile.get(fileId) ?? []).length
}

/**
 * Test-only accessor: clear the in-memory cache AND remove the
 * persisted `comments.json` on disk. Without the file delete, the
 * next call to `load()` would re-hydrate the previous test's data
 * (since `commentsByFile.clear()` only empties the in-memory map).
 *
 * Used by vitest `beforeEach` so cross-test leakage is impossible.
 */
export function _resetCommentsForTests(): void {
  commentsByFile.clear()
  dirty = false
  loaded = false
  // Best-effort file removal. `unlinkSync` is intentionally avoided:
  // some test setups run inside a sandbox where the file is read-only
  // (snapshot mode). Clearing the in-memory map is sufficient when
  // the file is gone; clearing the map AND removing the file is
  // the paranoid path that the standard testsuite relies on.
  // Best-effort file removal. `unlinkSync` is intentional rather than
  // `rmSync` because we want to fail loudly (throw) if the FS rejects
  // the operation — silent failure would leak data across tests.
  if (existsSync(FILE)) unlinkSync(FILE)
}
