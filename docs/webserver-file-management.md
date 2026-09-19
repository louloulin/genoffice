# Web-server File Management

The standalone web-server (`apps/web-server`) handles file upload, save,
read, and lifecycle for the web build of GenOffice. This document
captures the architecture after the WPS-grade refactor (Phase 0-2, 5)
and the contract it shares with the Electron desktop build
(`apps/docs/src/main`).

## Layering

```
┌────────────────────────────────────────────────────────────────────┐
│ Layer 1 — IPC handlers                                             │
│ apps/web-server/src/{docs,markdown,html,sheets,slides,pdf,shell}/  │
│   Thin adapters: parse args, call a store, format the result.      │
│   Domain-specific channels (close-state, settings, exports,        │
│   web-unsupported stubs) stay inline.                              │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ calls
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 2 — DocumentStore interface                                  │
│ packages/file-management/src/document-store.ts                     │
│   BaseDocumentStore + concrete stores (DocsStore, MarkdownStore,   │
│   HtmlStore). Sheets / Slides / Pdf stores are Phase 3 work.      │
│   Shared concerns: atomic-write, sha256, recents, project attach.  │
└─────────────────────────────┬──────────────────────────────────────┘
                              │ uses
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ Layer 3 — shared kernel                                            │
│ @genoffice/file-management:                                        │
│   - atomicWriteFile       (temp + rename, Windows-EPERM retry)     │
│   - UnifiedRecents        (restart-safe recent files)              │
│   - Trash, VersionHistory, SaveLocations, fileProperties, …        │
│ apps/web-server/src/common/:                                       │
│   - file-index-store.ts   (FileIndexStore — persisted in-memory)   │
│   - document-stores.ts    (pre-wired singleton trio)               │
│   - logger.ts             (structured stderr log)                  │
│   - paths.ts / mime.ts / registry.ts / codec.ts                    │
└────────────────────────────────────────────────────────────────────┘
```

## DocumentStore interface

```ts
interface DocumentStore<TExtras> {
  readonly format: string              // 'docx' | 'md' | 'html' | …
  readonly dirName: string             // 'docs' | 'markdown' | 'html' | …
  readonly extension: string           // '.docx' | '.md' | '.html'

  create(opts: CreateOptions): Promise<CreatedDoc>
  open(path: string): Promise<{ meta: DocumentMeta & TExtras; bytes: ArrayBuffer }>
  save(path: string, payload: Buffer, opts?: { projectId?: string; fileId?: string }): Promise<SaveResult>
  recentTouch(path: string): Promise<void>
}
```

`BaseDocumentStore` does the cross-format heavy lifting:

- `safeName()` strips path separators and control characters
- `ensureExtension()` appends the format extension when the caller omitted it
- `defaultDir()` resolves where newly-created files land (`DocsStore` overrides this to `FILES_DIR` so docx files stay where the renderer expects them)
- `create()` mkdirs the parent, atomic-writes, bumps recents, attaches to the project
- `open()` checks magic bytes, hashes (sha256), bumps recents
- `save()` mkdirs, atomic-writes, hashes, bumps recents, attaches on demand

Per-format concrete stores override three hooks: `verifyMagic()`, `initialBytes()`, `mimeType()`. Example:

```ts
class DocsStore extends BaseDocumentStore {
  readonly format = 'docx'
  readonly extension = '.docx'
  protected verifyMagic(bytes: Buffer): boolean { return looksLikeZip(bytes) }
  protected initialBytes(_name: string): Buffer { /* placeholder */ }
  protected mimeType(): string { return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  protected defaultDir(): string { return this.filesDir /* FILES_DIR for legacy layout */ }
}
```

## FileIndexStore

`apps/web-server/src/common/file-index-store.ts` persists the
`FILES_INDEX: Map<string, FileInfo>` from process memory to
`${DATA_DIR}/files-index.json` so a `files:read({id})` call after a
restart can find ids uploaded in a prior session.

### Concurrency model

The store protects against three races:

1. **Id collision under burst load.** `web:save-file` mixes a
   monotonic counter, `Date.now()`, a 6-char random suffix, and the
   user-supplied name into the id. Without the counter, 100 parallel
   uploads landing in the same millisecond collide on the same id and
   `fileIndex().set()` overwrites itself.
2. **Stale dirty flag.** A previous implementation used a
   Promise-chain + `dirty: boolean` flag. The first flush in a burst
   ran while the map was half-loaded, then cleared `dirty`, and
   subsequent flushes skipped — silently dropping entries. The fix:
   use a monotonic `gen` counter and capture `gen` at write start, not
   at completion, so concurrent sets during the await are not folded
   into the trailing `writtenGen` update.
3. **Read-modify-write interleaving.** `flushNow()` runs through
   `runExclusive(mutex)` so a burst of N `flushNow` calls serialise
   into at most one disk write (the last one to observe a bumped
   `gen`).

### Test coverage

- `tests/file-index-store.test.ts` — 20 unit tests covering fromDiskSync
  paths (missing, corrupt, partial), CRUD, flushNow serialisation,
  and a 200-call concurrent storm regression test.
- `tests/concurrent-upload.test.ts` — 4 e2e tests that boot the bundle
  and fire 100 parallel `web:save-file` calls, asserting all 100
  entries land on disk and the JSON parses cleanly.

## Recents and projects

- `unifiedRecents` (from `@genoffice/file-management`) is the
  restart-safe single source of truth for the home screen. Handlers
  call `await unifiedRecents.add(path, { projectId?, starred?, labels? })`
  instead of writing `DOCS_RECENT` / `docs-recent.json` directly.
- The legacy `DOCS_RECENT: Map<string, DocInfo>` continues to exist
  because `home:recents` still reads from it; we mirror every write
  into the legacy map until B8 fully migrates `home:recents` to
  `unifiedRecents.page()`. Removing the mirror today would break the
  in-session home screen.

## Logging

`apps/web-server/src/common/logger.ts` is the single funnel for
structured output. Every line is one JSON record on stderr:

```json
{"ts":"2026-09-19T22:13:55.123Z","level":"warn","module":"file-index","msg":"flush failed","err":{"name":"Error","message":"…","stack":"…"}}
```

- `installLoggerSink(sink)` lets tests capture log records.
- Errors are flattened to `{name, message, stack}` so the record is
  JSON-clean. Circular references fall back to `util.inspect`.

Migration plan: replace remaining `console.log/warn/error` calls with
`log.{level}(module, msg, meta)` as we touch each file. Phase 4
delivered the logger + 2 migrations (`file-index-store`, `sheets`).

## Watcher

The fs.watch on `FILES_DIR` (in `apps/web-server/src/shell/home.ts`)
is already a singleton: the `setupRecentsFileWatcher()` helper bails
out early when `recentsWatcher` is non-null. EPERM failures (some
sandboxes / containers) are absorbed into a no-op so the rest of the
IPC surface still works.

## Contract: web-server ↔ desktop main

| Capability                  | Web-server                              | Desktop (`apps/docs/src/main`)        | Notes |
|-----------------------------|-----------------------------------------|---------------------------------------|-------|
| File metadata index         | `FileIndexStore` (persisted JSON)       | `FILES_INDEX` (process-local Map)      | Same id shape; web survives restart |
| Recent files                | `unifiedRecents` (JSON-backed)          | `unifiedRecents` (same class)         | Same `RecentEntry` shape |
| Atomic save                 | `atomicWriteFile`                       | Same `atomicWriteFile` (cloned)       | Same Windows-EPERM retry |
| DocumentStore for `.docx`   | `DocsStore` (Phase 2)                   | TBD (Phase 3)                          | Same `DocumentMeta` shape |
| Encrypted docx detection    | `CFB_MAGIC` + `EncryptedPackage` check  | Same, plus password crypto             | Web surfaces `needsPassword` only |
| Sheet/PPT/PDF stores        | Stubs + `savePdfToPath` (PDF)           | Full implementations                   | Phase 3 |
| Logger                      | JSON-per-line on stderr                 | Same `log` interface (planned)         | Same record shape |
| Prom-client `/metrics`      | Not yet                                 | Not yet                               | Phase 4 follow-up |

## Test matrix

| Suite                                | Tests | Status |
|--------------------------------------|-------|--------|
| `apps/web-server` file-management    | 23    | ✅ |
| `apps/web-server` file-index-store   | 20    | ✅ |
| `apps/web-server` concurrent-upload  | 4     | ✅ |
| `apps/web-server` logger             | 7     | ✅ |
| `apps/web-server` managed-path-guard | 39    | ✅ |
| `apps/web-server` ipc-error-status   | 28    | ✅ |
| `packages/file-management`           | 72    | ✅ |

Run them all:

```bash
cd apps/web-server
../../node_modules/.bin/vitest run \
  tests/file-management.test.ts \
  tests/file-index-store.test.ts \
  tests/concurrent-upload.test.ts \
  tests/logger.test.ts \
  tests/managed-path-guard.test.ts \
  tests/ipc-error-status.test.ts
```

## Phase status

| Phase | Status | Summary |
|-------|--------|---------|
| 0 atomic + dual-write              | ✅ | 17 atomic writes across 7 files; double-write to legacy mirror consolidated. |
| 1 FileIndex persistence + Mutex    | ✅ | `file-index-store.ts`, `saveProjects` sync atomic, 18 unit + 2 e2e tests. |
| 2 DocumentStore interface + 3 stores | ✅ | `BaseDocumentStore` + Docs/Markdown/Html stores, 16 unit + 3 e2e tests. |
| 3 sheets/slides/pdf stores         | ⏳ | Pdf uses `savePdfToPath` external helper; Sheets/Slides need `WorkbookStore` / `SlideDeckStore` interfaces (separate design). |
| 4 logger + watcher                 | ✅ (partial) | Structured logger with 2 migrations; watcher already a singleton. Prom-client `/metrics` is Phase 4 follow-up. |
| 5 concurrent + crash simulation    | ✅ | 100-call storm e2e + 200-call unit regression + crash simulation; found and fixed 2 real concurrency bugs. |
| 6 docs (this file)                 | ✅ | Layered architecture, DocumentStore reference, FileIndexStore concurrency model, web ↔ desktop contract table. |
