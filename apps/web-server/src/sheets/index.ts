/**
 * Sheets IPC channels — workbook open/has-queued/consume-new-blank.
 * Persistence uses `sheets-recent.json` for the recent-files list.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { atomicWriteFile } from '../common/atomic'
import { basename, dirname, extname, join } from 'node:path'
import {
  DOCS_RECENT,
  FILES_DIR,
  isManagedPath,
  loadRecentSheets,
  PATH_OUTSIDE_STORAGE,
  registerHandle,
  requireManagedPath,
  saveRecentSheets,
  writeBlankOfficeFile,
} from '../common/index'
import { recordRecentDoc } from '../common/document-stores'
import { notifyFileSaved } from '../common/webhooks-store'
import { sendIpcEvent } from '../common/event-broadcast'
import { captureBeforeSave } from '../common/version-history'
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'
import { WebSheetsSidecar } from './sidecar'
import { getSidecarPool, type WebSheetsSidecarPool } from './sidecar-pool'

/**
 * Module-level singleton of the sidecar pool. Each call routes to one
 * of N independent `xlsx-sidecar` child processes — see sidecar-pool.ts
 * (sdk1 §11.87 P1-3) for why a single sidecar is a 99.7% save-pipeline
 * wall-clock bottleneck. The pool's surface mirrors `WebSheetsSidecar`
 * so existing call sites (`saveWorkbookViaSidecar({client, ...})` etc.)
 * work without changes.
 */
const sheetsSidecar: WebSheetsSidecarPool = getSidecarPool()
import {
  detectFormat,
  getSession,
  registerSession,
  updateTarget,
  forgetSession,
  newSnapshotPath,
  promoteSnapshot,
} from './registry'
import { saveWorkbookViaSidecar } from '@genoffice/xlsx-gateway/gateway/xlsx-package-io'
import { csvToXlsxBuffer, decodeCsvBuffer } from '@genoffice/xlsx-gateway/gateway/csv-import'
import {
  WorkbookCorruptError,
  WorkbookInvalidArgumentError,
  WorkbookNotFoundError,
  WorkbookOpenFailedError,
  WorkbookSaveFailedError,
} from './errors'
import { MAX_RANGE_CELLS, validateRangeRequest } from './range-bounds'


export function registerSheetsHandlers(): void {
  registerHandle('sheets:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { xlsx?: ArrayBuffer; path?: string } | undefined
    const id = `sheet-${Date.now()}`
    const name = `表格-${new Date().toLocaleDateString()}.xlsx`
    const path = join(FILES_DIR, `${id}.xlsx`)

    if (opts?.xlsx) {
      writeFileSync(path, Buffer.from(opts.xlsx))
    } else if (opts?.path) {
      /* Caller supplied a path but no bytes; trust it. */
    } else {
      /* No bytes, no path: cold-start "give me a blank workbook" path.
       * Materialise a real openable xlsx so the recents row we are about
       * to append actually points at a file on disk. Without this fallback
       * every cold-start click left a "missing" tile in the home grid. */
      writeBlankOfficeFile('xlsx', path)
    }

    const recent = loadRecentSheets()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSheets(recent)
    /* Mirror into unifiedRecents so home:recents (the home grid) surfaces
     * this row. Without it cold-start clicks are invisible to the home tile
     * even though the file actually exists at `path`. */
    void recordRecentDoc(path, { id, name, modified: false })

    return { id, path, name }
  })

  registerHandle('sheets:has-queued-workbook', () => false)

  registerHandle('workbook:open-path', async (_event: unknown, filePath: unknown) => {
    /* The user-picked path is what `csvPath` must echo back: the renderer's
     * Save uses it to write the values back to the SAME file the user opened
     * (Excel's behavior). `path` may be different by the time we reach the
     * CSV-conversion step below, because a `storage://` URI would have been
     * staged into FILES_DIR by then. */
    const originalFilePath = typeof filePath === 'string' ? filePath : ''
    // The xlsx-sidecar reads files from disk only. Accept either a
    // managed FILES_DIR path or a `storage://<backend>/<key>` URI by
    // staging storage URIs into FILES_DIR first so the sidecar can open
    // them. `requireManagedPath` on its own rejected every upload —
    // `web:save-file` returns a storage URI — so the home recents tile
    // was clickable but the click answered 400.
    let path: string
    let staged: string | null = null
    const key = storageKeyFromPath(typeof filePath === 'string' ? filePath : '')
    if (key) {
      try {
        const u8 = await getStorageBackend().get(key)
        // Insert the timestamp before the extension so the sidecar's
        // extension-based parser still recognises the file as xlsx; the
        // older `${basename}.staged-<ts>` shape landed as e.g.
        // `hash.xlsx.staged-1234567890`, which the sidecar read as
        // extension `.staged-1234567890` and refused to parse.
        const dot = key.lastIndexOf('.')
        const stem = dot > 0 ? key.slice(0, dot) : key
        const ext = dot > 0 ? key.slice(dot) : ''
        staged = join(FILES_DIR, `${basename(stem)}.staged-${Date.now()}${ext}`)
        const stagedDir = dirname(staged)
        if (!existsSync(stagedDir)) mkdirSync(stagedDir, { recursive: true })
        atomicWriteFile(staged, Buffer.from(u8))
        path = staged
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          throw new WorkbookNotFoundError('workbook:open-path', `File not found: ${String(filePath)}`)
        }
        throw err
      }
    } else {
      path = requireManagedPath('workbook:open-path', filePath)
      if (!existsSync(path)) {
        throw new WorkbookNotFoundError('workbook:open-path', `File not found: ${path}`)
      }
    }

    const bytes = readFileSync(path)
    // Prefer the display name already recorded by `web:save-file` so the
    // returned workbook carries the user's filename (e.g. "Budget.xlsx")
    // instead of the storage-hash basename. Falls back to the renderer's
    // path for legacy callers (direct FILES_DIR paths).
    const requestedPath = typeof filePath === 'string' ? filePath : path
    const name = DOCS_RECENT.get(requestedPath)?.name ?? basename(requestedPath)
    const id = `sheet-${Date.now()}`

    /* The sidecar is zip/xlsx-only. Hand it a `.csv` or a legacy BIFF `.xls`
     * and it fails with `invalid Zip archive: Could not find EOCD`, which the
     * catch below turns into a misleading "corrupt archive" error. The file
     * picker advertises `.xlsx,.xlsm,.xls,.csv`, so a user who chose the
     * menu's own filter got told their good file was corrupt.
     *
     * Desktop solves this in `prepareWorkbookForOpen` by converting to a temp
     * `.xlsx` first and remembering the original as the save target. Same
     * idea here; the converted copy lands in the snapshot dir so the existing
     * session-eviction path owns its cleanup.
     *
     * `@genoffice/xlsx-gateway`'s CSV reader is pure TS + JSZip with a
     * charset sniffer (`decodeCsvBuffer` tries gb18030 / shift_jis / big5 /
     * euc-kr before falling back), so a Chinese Excel CSV round-trips instead
     * of turning into replacement characters. Runs BEFORE the sidecar so the
     * sidecar only ever sees a real xlsx. */
    let csvSourcePath: string | undefined
    const sourceFormat = detectFormat(path)
    if (sourceFormat === 'csv') {
      const converted = await csvToXlsxBuffer(decodeCsvBuffer(readFileSync(path)))
      const convertedPath = newSnapshotPath(path)
      atomicWriteFile(convertedPath, converted)
      csvSourcePath = originalFilePath || path
      path = convertedPath
    } else if (sourceFormat === 'xls') {
      // Legacy BIFF `.xls` needs the Rust `convertWorkbook` the desktop calls;
      // that command is not exposed on `WebSheetsSidecar`. Naming the real
      // reason beats the misleading "corrupt archive" a zip-only parse gives.
      throw new WorkbookCorruptError(
        'workbook:open-path',
        'Legacy .xls workbooks are not supported by the web build yet — convert to .xlsx first.',
      )
    }

    // The renderer expects a fully parsed WorkbookFile (workbookFileSchema in
    // apps/sheets/src/shared/desktop-api.ts). The Electron main process parses
    // xlsx via the xlsx-sidecar; on the web we spawn the same sidecar binary
    // and merge its result with the local sha256/fileBytes/path metadata.
    let workbook: Record<string, unknown>
    try {
      // `path` is the guarded value: passing the raw parameter here was a cast
      // that skipped the check the line above exists to apply.
      const result = (await sheetsSidecar.open(path)) as Record<string, unknown>
      workbook = { ...result }
    } catch (err) {
      // A file that is not a workbook is a client-side problem (422), not a
      // server fault: this used to surface as an unhandled 500. The finally
      // block cleans up any staged copy so a corrupt upload does not leave
      // a `*.staged-<ts>` orphan in FILES_DIR.
      throw new WorkbookCorruptError(
        'workbook:open-path',
        `Failed to parse workbook: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    // Note: do NOT unlink `staged` here — the save pipeline reads the bytes
    // this session was opened against, exactly like the desktop
    // `snapshotWorkbook` discipline. The session registry owns the staged
    // file's lifecycle: `forgetSession` removes it on eviction/abort.
    // A previous iteration unlinked in this `finally` and left the save
    // pipeline with a missing source path (ENOENT).

    // Recorded only now that the workbook actually parses: a corrupt file used
    // to reach the recents list and then fail, so "recently opened" listed
    // documents that never opened.
    const recent = loadRecentSheets()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSheets(recent)

    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const openedPath = typeof filePath === 'string' ? filePath : path
    // Register the session AFTER the workbook parses cleanly. The sidecar
    // returns its own sessionId (see xlsx-engine `WorkbookSessions::open_with_locale`);
    // the renderer echoes that id back on every subsequent call so we key
    // the registry on it. Without this registration the save pipeline has no
    // way to know which `.xlsx` to patch, and every save attempt answered
    // `WEB_UNSUPPORTED`.
    const sidecarSessionId =
      typeof workbook?.sessionId === 'string' ? (workbook.sessionId as string) : id
    registerSession({
      sessionId: sidecarSessionId,
      sourcePath: path,
      targetPath: openedPath,
      format: detectFormat(openedPath),
      staged: staged ?? undefined,
    })
    return {
      ...workbook,
      id,
      // Echo the renderer-supplied path (or the resolved managed path)
      // back unchanged, matching the desktop contract the renderer
      // imports (apps/sheets/src/shared/desktop-api.ts).
      path: openedPath,
      name,
      sha256,
      fileBytes: bytes.byteLength,
      // The renderer's Save keeps the CSV identity when this is present
      // (`save-actions.ts`: `state.file.csvPath !== undefined`), so it must
      // point at the original `.csv`, never the converted copy.
      ...(csvSourcePath === undefined ? {} : { csvPath: csvSourcePath }),
    }
  })

  registerHandle('sheets:consume-new-blank', () => ({ ok: true }))
  registerHandle('workbook:pending-edits', () => ({ ok: true }))

  // The renderer pings workbook:read-range to stream cells for the visible
  // viewport. We forward the call to the xlsx-sidecar (the same Rust binary
  // the Electron main process owns); the empty fallback only fires if the
  // sidecar is unreachable or the session expired.
  registerHandle('workbook:read-range', async (_event: unknown, request: unknown) => {
    /* Validate before anything else touches the bounds. The two failure
     * modes this prevents are both reachable from an untrusted HTTP client:
     *
     *   1. `emptyRange` below materialises one record per row, so an
     *      unclamped `endRow - startRow + 1` is an allocation the caller
     *      sizes. `{ startRow: -1, endRow: 999999 }` produced a ~30 MB
     *      response and ~300 MB RSS; four concurrent calls exceeded 1 GB.
     *   2. A negative bound fails the sidecar's `usize` deserialisation,
     *      which replies `invalid_json` with an empty `requestId`. The
     *      client correlates by id, drops the reply, and stalls for the
     *      full timeout — answering a read took 30 s.
     *
     * Every other layer (renderer `parseRangeRequest`, desktop main process
     * `workbookRangeRequestSchema`, Rust `CellRange::validate`) already
     * rejects these inputs, so this is the web build catching up rather than
     * a new contract. See ./range-bounds.ts. */
    const validated = validateRangeRequest(request)
    if (!validated.ok) {
      throw new WorkbookInvalidArgumentError('workbook:read-range', validated.reason)
    }
    const { sessionId, sheetId, range } = validated.request
    // Look the session up in the registry so the sidecar pool can route by
    // source path (the xlsx-sidecar keeps sessions in-process; with the
    // §11.87 multi-process pool, a session opened on worker A is only
    // readable on worker A). The sessionId is timestamp-derived and would
    // hash to a different worker ~3/4 of the time — the empty-cell flake
    // the workbook-save e2e suite had been racing against.
    const session = getSession(sessionId)
    try {
      const result = (await sheetsSidecar.readRange({
        sessionId,
        sheetId,
        range,
        ...(session?.sourcePath ? { path: session.sourcePath } : {}),
      })) as Record<string, unknown>
      return normalizeRangeResult(result, range.endRow)
    } catch (err) {
      // Sidecar session expired: the sidecar is per-process and resets on
      // process restart, so we may have lost the session. Return empty cells
      // rather than a hard error so the workbook metadata still shows up.
      console.warn('[sheets] read-range sidecar failed:', err)
      return emptyRange(range.startRow, range.endRow)
    }
  })

  const imageMime: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
  }
  // The element-wise channels below answer per item rather than throwing, so a
  // path outside managed storage becomes that item's error instead of a 400 for
  // the whole batch — the renderer already renders `{ ok: false, error }`.
  registerHandle('sheets:files-add', (_event: unknown, paths: unknown) => {
    const values = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    return values.map((path) => {
      if (!isManagedPath(path)) return { path, ok: false, error: PATH_OUTSIDE_STORAGE }
      if (!existsSync(path)) return { path, ok: false, error: 'file not found' }
      const info = statSync(path)
      return { path, ok: info.isFile(), name: basename(path), sizeBytes: info.size }
    })
  })
  registerHandle(
    'sheets:files-read',
    (_event: unknown, path: unknown, offset: unknown, maxChars: unknown) => {
      if (typeof path !== 'string' || !isManagedPath(path))
        return { ok: false, error: PATH_OUTSIDE_STORAGE }
      if (!existsSync(path)) return { ok: false, error: 'file not found' }
      const ext = extname(path).slice(1).toLowerCase()
      if (imageMime[ext]) return { ok: false, error: 'image has no text' }
      const text = readFileSync(path, 'utf8')
      const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0)
      const size = Math.min(
        48000,
        Math.max(1, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1),
      )
      return {
        ok: true,
        name: basename(path),
        totalChars: text.length,
        offset: start,
        text: text.slice(start, start + size),
      }
    },
  )
  registerHandle('sheets:files-read-image', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !isManagedPath(path))
      return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (!existsSync(path)) return { ok: false, error: 'file not found' }
    const ext = extname(path).slice(1).toLowerCase()
    const mime = imageMime[ext]
    if (!mime) return { ok: false, error: 'not an image' }
    const bytes = readFileSync(path)
    if (bytes.length > 5 * 1024 * 1024) return { ok: false, error: 'image is too large' }
    return { ok: true, base64: bytes.toString('base64'), mime }
  })
  registerHandle(
    'sheets:files-add-pasted-image',
    (_event: unknown, data: unknown, ext: unknown) => {
      const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
      const bytes =
        data instanceof ArrayBuffer
          ? Buffer.from(data)
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : null
      if (!bytes || !imageMime[cleanExt] || bytes.length === 0 || bytes.length > 20 * 1024 * 1024)
        return { accepted: [], rejected: ['invalid image'] }
      const name = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`
      const path = join(FILES_DIR, name)
      writeFileSync(path, bytes)
      return { accepted: [{ path, name, ext: cleanExt, sizeBytes: bytes.length }], rejected: [] }
    },
  )

  registerHandle('workbook:open-for-merge', (_event: unknown, paths: unknown) => {
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 20) {
      throw new WorkbookInvalidArgumentError('workbook:open-for-merge', 'merge sources must be 1-20 files')
    }
    return paths.map((path) => {
      if (typeof path !== 'string' || !isManagedPath(path)) {
        throw new WorkbookInvalidArgumentError('workbook:open-for-merge', PATH_OUTSIDE_STORAGE)
      }
      if (!existsSync(path)) {
        // A caller-supplied path that does not exist is a 404, not a server
        // fault: the renderer shows "file moved or deleted" for this case.
        throw new WorkbookNotFoundError(
          'workbook:open-for-merge',
          `Merge source not found: ${String(path)}`,
        )
      }
      return { path, name: basename(path) }
    })
  })

  // ----- Save (real, web-build implementation) -----------------------------
  //
  // The desktop flow applies workbook edits through the Rust xlsx-sidecar
  // (`sheets-main.ts:3005` `ipcMain.handle('workbook:save', ...)`) — the
  // sidecar reads the .xlsx, applies the JSON editsJson patch, and writes
  // the file back. The web build does the same: the sidecar already speaks
  // `archive_manifest` + `save_archive` + `read_entries` + `scan_entries`
  // (`apps/sheets/native/xlsx-engine/src/main.rs`), and `@genoffice/xlsx-gateway`
  // already implements `saveWorkbookViaSidecar` — the TS pipeline that
  // turns a `WorkbookSaveRequest` into a manifest + replacement plan.
  //
  // What's web-only:
  //   - Session registry (`sheets/registry.ts`) holds the source path so a
  //     save always patches the bytes this session was opened against,
  //     matching the desktop `snapshotWorkbook` snapshot discipline.
  //   - Recents are recorded on successful save so the home grid shows
  //     `modified: true`, matching docs/markdown behaviour.
  //   - A renderer that never opened a workbook (calls `workbook:save`
  //     with an unknown sessionId) gets a structured `WorkbookNotFoundError`
  //     from `./errors` instead of the previous silently-accepted
  //     `{ok: false}`. Every workbook:* throwable is now routed through the
  //     workbook-specific error module so HTTP status mapping and renderer
  //     payloads are uniform (sdk1 §11.65 — full workbook unification).

  type WorkbookFormat = 'xlsx' | 'xlsm' | 'csv' | 'xls'

  interface WorkbookSaveRequest {
    sessionId?: string
    targetPath?: string
    mode?: 'save' | 'save-as'
    edits?: unknown[]
    structuralOps?: unknown[]
    chartEdits?: unknown[]
    sheetPlan?: unknown
    filterStates?: unknown[]
    hyperlinkEdits?: unknown[]
    cfStates?: unknown[]
    dvStates?: unknown[]
    sheetProtections?: unknown[]
    definedNamesState?: unknown
    visualAdditions?: unknown[]
    pageSetupStates?: unknown[]
    noteStates?: unknown[]
    tableAdditions?: unknown[]
    pivotAdditions?: unknown[]
    pivotCacheRefreshPaths?: string[]
    pivotRefreshUpdates?: unknown[]
    visualEdits?: unknown[]
    sparklineAdditions?: unknown[]
    formulaValues?: unknown[]
    themeState?: unknown
    workbookProtectionState?: unknown
    protectedRangeStates?: unknown[]
    bulkConstantFills?: unknown[]
    sheetOps?: unknown[]
    sheetOrder?: string[]
  }

  /** The streaming-save entry point. Both `workbook:save` and
   *  `workbook:save-as` route through here after resolving the
   *  session and the target path. */
  async function runWorkbookSave(input: {
    request: WorkbookSaveRequest
    cancelled?: () => boolean
  }): Promise<{
    ok: boolean
    canceled?: boolean
    error?: string
    touchedEntries?: string[]
    removedEntries?: string[]
    addedEntries?: string[]
    path?: string
  }> {
    const req = input.request
    if (!req || typeof req.sessionId !== 'string' || !req.sessionId) {
      throw new WorkbookInvalidArgumentError(
        'workbook:save',
        'expects { sessionId: string, ... }',
      )
    }
    const session = getSession(req.sessionId)
    if (!session) {
      // A renderer that lost track of its sessionId (e.g. after the server
      // restarted) sees a clear error rather than a silent save success.
      throw new WorkbookNotFoundError('workbook:save', `Unknown session: ${req.sessionId}`)
    }

    // Resolve the target: save-as overrides, otherwise stay on the open path.
    const requestedTarget =
      typeof req.targetPath === 'string' && req.targetPath.length > 0
        ? req.targetPath
        : session.targetPath
    // A save-as to a brand-new path needs to live inside managed storage;
    // a save back over the original just reuses the open path.
    if (req.mode === 'save-as' && (!requestedTarget.startsWith(FILES_DIR))) {
      return { ok: false, error: 'save-as target must be inside FILES_DIR' }
    }
    if (requestedTarget !== session.targetPath) {
      updateTarget(session.sessionId, requestedTarget)
    }

    // Promote the staged snapshot so a save-as that goes outside FILES_DIR
    // (unusual but legal in tests) still has a path that points at real
    // bytes. The save pipeline below only needs `session.sourcePath`,
    // which is the staged path; promotion keeps the canonical path warm
    // so the next open matches.
    promoteSnapshot(session.sessionId, requestedTarget)

    const sourcePath = session.sourcePath
    if (!sourcePath) {
      return { ok: false, error: 'workbook:save: session has no source path' }
    }

    try {
      // Snapshot prior bytes BEFORE the sidecar overwrites requestedTarget
      // so the renderer can roll back via files:restore-version. The sidecar
      // does an atomic promote (tmp + rename) into requestedTarget; capture
      // must run first.
      try {
        const prev = readFileSync(requestedTarget)
        captureBeforeSave(basename(requestedTarget), prev)
      } catch { /* new file, nothing to snapshot */ }
      const result = await saveWorkbookViaSidecar({
        client: sheetsSidecar,
        sourcePath,
        targetPath: requestedTarget,
        edits: (req.edits ?? []) as never,
        structuralOps: (req.structuralOps ?? []) as never,
        chartEdits: (req.chartEdits ?? []) as never,
        sheetPlan: req.sheetPlan as never,
        filterStates: (req.filterStates ?? []) as never,
        hyperlinkEdits: (req.hyperlinkEdits ?? []) as never,
        cfStates: (req.cfStates ?? []) as never,
        dvStates: (req.dvStates ?? []) as never,
        sheetProtections: (req.sheetProtections ?? []) as never,
        definedNamesState: (req.definedNamesState as never) ?? null,
        visualAdditions: (req.visualAdditions ?? []) as never,
        pageSetupStates: (req.pageSetupStates ?? []) as never,
        noteStates: (req.noteStates ?? []) as never,
        tableAdditions: (req.tableAdditions ?? []) as never,
        pivotAdditions: (req.pivotAdditions ?? []) as never,
        pivotCacheRefreshPaths: req.pivotCacheRefreshPaths ?? [],
        pivotRefreshUpdates: (req.pivotRefreshUpdates ?? []) as never,
        visualEdits: (req.visualEdits ?? []) as never,
        sparklineAdditions: (req.sparklineAdditions ?? []) as never,
        formulaValues: (req.formulaValues ?? []) as never,
        themeState: (req.themeState as never) ?? null,
        workbookProtectionState:
          (req.workbookProtectionState as never) ?? null,
        protectedRangeStates: (req.protectedRangeStates ?? []) as never,
        bulkConstantFills: (req.bulkConstantFills ?? []) as never,
      })
      // Mirror to recents so the home grid reflects `modified: true` and
      // the entry survives a restart. Without this the save succeeded on
      // disk but the home tile stayed clean and the user assumed nothing
      // had landed.
      await recordRecentDoc(requestedTarget, { modified: true })
      notifyFileSaved(requestedTarget, { format: extname(requestedTarget).slice(1) || 'xlsx' })
      return {
        ok: true,
        path: requestedTarget,
        touchedEntries: [...result.touchedEntries],
        removedEntries: [...result.removedEntries],
        addedEntries: [...result.addedEntries],
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // `promoteFileAtomically` in the gateway only renames the temp into
      // place when the manifest check passes, so a save that races with an
      // external rewrite surfaces here as a clear error rather than a
      // corrupted file. Return it as `{ ok: false }` rather than letting
      // it bubble — the renderer's save flow branches on this exact shape.
      return { ok: false, error: message }
    }
  }

  registerHandle('workbook:save', async (event: unknown, request: unknown) => {
    const result = await runWorkbookSave({ request: (request ?? {}) as WorkbookSaveRequest })
    if (result.ok && result.path) {
      sendIpcEvent(event, 'saved', {
        path: result.path,
        version: Date.now(),
        format: 'xlsx',
      })
    }
    return result
  })

  registerHandle('workbook:save-as', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as WorkbookSaveRequest
    if (typeof req.targetPath !== 'string' || !req.targetPath) {
      return { ok: false, error: 'workbook:save-as expects { targetPath: string, ... }' }
    }
    return runWorkbookSave({ request: { ...req, mode: 'save-as' } })
  })

  registerHandle('workbook:save-edits-begin', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as WorkbookSaveRequest
    if (typeof req.sessionId !== 'string' || !req.sessionId) {
      return { ok: false, error: 'workbook:save-edits-begin expects { sessionId }' }
    }
    const session = getSession(req.sessionId)
    if (!session) {
      throw new WorkbookNotFoundError(
        'workbook:save-edits-begin',
        `Unknown session: ${req.sessionId}`,
      )
    }
    // Web build doesn't chunk over IPC: the renderer sends the full
    // editsJson in `workbook:save`. We echo the sessionId back so the
    // renderer can correlate the begin/save pair, and reserve a target
    // path up front. The actual write happens in `workbook:save`.
    return {
      ok: true,
      sessionId: req.sessionId,
      targetPath: session.targetPath,
    }
  })

  registerHandle('workbook:save-edits-chunk', async (_event: unknown, request: unknown) => {
    // Chunks aren't separately persisted on the web build; the save
    // collects edits on the final `workbook:save` call. We accept and
    // acknowledge so a renderer that emits chunks for protocol symmetry
    // sees a non-error response.
    const req = (request ?? {}) as { sessionId?: string; chunk?: unknown }
    if (typeof req.sessionId !== 'string' || !req.sessionId) {
      return { ok: false, error: 'workbook:save-edits-chunk expects { sessionId }' }
    }
    return { ok: true, sessionId: req.sessionId, accumulated: false }
  })

  registerHandle('workbook:save-edits-abort', (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as { sessionId?: string }
    if (typeof req.sessionId === 'string') {
      // Drop the session entry — the renderer is rolling back; there is
      // no byte-level state to undo on the web build because chunks
      // aren't persisted separately.
      forgetSession(req.sessionId)
    }
    return { ok: true, aborted: true }
  })

  // write-recovery-copy is the renderer's auto-save snapshot: write the
  // current target bytes into a stable recovery path so a renderer reload
  // after a crash can recover. The previous stub silently accepted and
  // dropped, which read to the user as "auto-save is on but never
  // actually saves".
  registerHandle('workbook:write-recovery', async (_event: unknown, request: unknown) => {
    const req = (request ?? {}) as { sessionId?: string; bytes?: unknown }
    if (typeof req.sessionId !== 'string' || !req.sessionId) {
      return { ok: false, error: 'workbook:write-recovery expects { sessionId, bytes }' }
    }
    const session = getSession(req.sessionId)
    if (!session) {
      return { ok: false, error: `Unknown session: ${req.sessionId}` }
    }
    const u8 = (() => {
      if (req.bytes instanceof ArrayBuffer) return new Uint8Array(req.bytes)
      if (ArrayBuffer.isView(req.bytes as ArrayBufferView))
        return new Uint8Array(
          (req.bytes as ArrayBufferView).buffer,
          (req.bytes as ArrayBufferView).byteOffset,
          (req.bytes as ArrayBufferView).byteLength,
        )
      return null
    })()
    if (!u8 || u8.byteLength === 0) {
      return { ok: false, error: 'workbook:write-recovery: bytes must be a non-empty binary view' }
    }
    const recoveryPath = join(FILES_DIR, `.recovery-${session.sessionId}.xlsx`)
    try {
      atomicWriteFile(recoveryPath, Buffer.from(u8))
      return { ok: true, path: recoveryPath }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /* ── CSV export ─────────────────────────────────────────────────────────
   * The desktop CSV export (`sheets-main.ts` `IPC_CHANNELS.exportCsv`) is
   * reachable from `csv-export.ts` in the renderer (File menu > Export as
   * CSV). The web build needs the channel too, otherwise the menu item
   * console-errors `UNSUPPORTED` and silently does nothing.
   *
   * Two things the desktop does that the web build cannot:
   *  - The native "formulas will be lost" warning dialog (Electron
   *    `dialog.showMessageBox`). The web build skips it — the renderer is
   *    responsible for any UX prompt and the contract's `hasFormulas`
   *    field still flows through so the host SDK can display its own
   *    warning in its iframe.
   *  - The native save-file dialog when the caller omits `targetPath`.
   *    The web build has no native dialog, so omitting `targetPath` is
   *    a structured `{canceled: true}` — the renderer then routes into
   *    `downloadAs` (which writes via the in-browser download path) or
   *    shows a save-as dialog of its own.
   */
  registerHandle('workbook:export-csv', async (_event: unknown, request: unknown) => {
    if (typeof request !== 'object' || request === null) {
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'request must be an object')
    }
    const req = request as {
      fileName?: unknown
      content?: unknown
      hasFormulas?: unknown
      activeSheetName?: unknown
      targetPath?: unknown
    }
    if (typeof req.fileName !== 'string' || req.fileName.length === 0 || req.fileName.length > 255) {
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'fileName must be a 1-255 character string')
    }
    if (typeof req.content !== 'string') {
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'content must be a string')
    }
    // Cap content at 64 MB worth of text — the same ceiling the desktop
    // uses (`MAX_CSV_EXPORT_CHARS`). A larger export is a client-side bug,
    // not a host we can sanely accept without bumping the bundle's
    // transitive caps.
    if (req.content.length > 64_000_000) {
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'content exceeds 64 MB ceiling')
    }
    if (req.content.length === 0) {
      // The renderer's csv-export.ts serializes the active sheet before
      // reaching this channel; an empty string at the IPC boundary is
      // almost always a renderer bug, and a 3-byte BOM-only file would
      // confuse Excel and downstream tooling. Refuse with the standard
      // INVALID_ARGUMENT envelope rather than writing a meaningless file.
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'content must not be empty')
    }
    if (req.targetPath !== undefined && typeof req.targetPath !== 'string') {
      throw new WorkbookInvalidArgumentError('workbook:export-csv', 'targetPath must be a string when provided')
    }
    if (req.targetPath === undefined) {
      // See the comment above — the web build has no native save dialog.
      return { canceled: true as const }
    }
    let safeTarget: string
    try {
      safeTarget = requireManagedPath('workbook:export-csv', req.targetPath)
    } catch (err) {
      // requireManagedPath throws the generic `InvalidArgumentError`; we
      // re-raise as `WorkbookInvalidArgumentError` so the renderer sees
      // a workbook-specific code on every error path this channel can
      // produce. Without this wrap, the path-outside-storage branch
      // would answer `INVALID_ARGUMENT` while every other branch on the
      // same channel answers `WORKBOOK_INVALID_ARGUMENT` — a mix the
      // renderer would have to special-case.
      throw new WorkbookInvalidArgumentError('workbook:export-csv', (err as Error)?.message ?? PATH_OUTSIDE_STORAGE)
    }
    const targetPath = safeTarget.toLowerCase().endsWith('.csv') ? safeTarget : `${safeTarget}.csv`
    // UTF-8 BOM so Excel decodes the reopened file correctly — the same
    // magic bytes the desktop exportCsv uses, and the same as the
    // workbook:create-document handler in this file. The BOM is three
    // bytes, so the file size matches `content.length + 3`.
    const csvBytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(req.content, 'utf8'),
    ])
    atomicWriteFile(targetPath, csvBytes)
    notifyFileSaved(targetPath, { format: 'csv', size: csvBytes.byteLength })
    recordRecentDoc(targetPath, { modified: true })
    return { canceled: false as const, path: targetPath }
  })

  // auto-rename: the desktop main process watches edits and suggests a
  // fresh filename. The web build doesn't have enough signal to invent a
  // meaningful rename, so we return null (the renderer falls back to its
  // own heuristic) instead of fabricating a name.
  registerHandle('workbook:auto-rename', () => null)
}

/**
 * Empty-cells reply for a range the sidecar could not answer.
 *
 * `rows` is derived from the caller's `[startRow, endRow]` rather than taken
 * as a separate count so the two cannot disagree, and the span is capped at
 * `MAX_RANGE_CELLS` as a backstop: the handler validates the request before
 * reaching here (see ./range-bounds.ts), but this function is the one that
 * turns a bad bound into an allocation, so it enforces its own ceiling too.
 */
function emptyRange(startRow: number, endRow: number): Record<string, unknown> {
  const rows = Math.min(Math.max(0, endRow - startRow + 1), MAX_RANGE_CELLS)
  return {
    cells: [],
    rows: Array.from({ length: rows }, (_, i) => ({
      row: Math.max(0, startRow) + i,
      hidden: false,
    })),
    merges: [],
    hyperlinks: [],
    conditionalRules: [],
    autoFilter: null,
    autoFilterColumns: [],
    dataValidations: [],
    styles: [],
    indexedThroughRow: endRow,
    indexingComplete: true,
    sheetProtection: null,
    protectedRanges: [],
    rowBreaks: [],
    colBreaks: [],
  }
}

function normalizeRangeResult(
  result: Record<string, unknown>,
  endRow: number,
): Record<string, unknown> {
  // The xlsx-sidecar returns rows / cells / merges / hyperlinks / etc. directly
  // in the WorkbookRangeResult shape (workbookRangeResultSchema). Forward as-is
  // and only fill in missing pagination markers the renderer expects.
  return {
    cells: Array.isArray(result.cells) ? result.cells : [],
    rows: Array.isArray(result.rows) ? result.rows : [],
    merges: Array.isArray(result.merges) ? result.merges : [],
    hyperlinks: Array.isArray(result.hyperlinks) ? result.hyperlinks : [],
    conditionalRules: Array.isArray(result.conditionalRules) ? result.conditionalRules : [],
    autoFilter: result.autoFilter ?? null,
    autoFilterColumns: Array.isArray(result.autoFilterColumns) ? result.autoFilterColumns : [],
    dataValidations: Array.isArray(result.dataValidations) ? result.dataValidations : [],
    styles: Array.isArray(result.styles) ? result.styles : [],
    indexedThroughRow:
      typeof result.indexedThroughRow === 'number' ? result.indexedThroughRow : endRow,
    indexingComplete: typeof result.indexingComplete === 'boolean' ? result.indexingComplete : true,
    sheetProtection: result.sheetProtection ?? null,
    protectedRanges: Array.isArray(result.protectedRanges) ? result.protectedRanges : [],
    rowBreaks: Array.isArray(result.rowBreaks) ? result.rowBreaks : [],
    colBreaks: Array.isArray(result.colBreaks) ? result.colBreaks : [],
  }
}
