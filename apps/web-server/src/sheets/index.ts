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
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'
import { WebSheetsSidecar } from './sidecar'
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
import { CorruptError, InvalidArgumentError, NotFoundError } from '../ai/errors'

const sheetsSidecar = new WebSheetsSidecar()

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
          throw new NotFoundError('workbook:open-path', `File not found: ${String(filePath)}`)
        }
        throw err
      }
    } else {
      path = requireManagedPath('workbook:open-path', filePath)
      if (!existsSync(path)) {
        throw new NotFoundError('workbook:open-path', `File not found: ${path}`)
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
      throw new CorruptError(
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
    }
  })

  registerHandle('sheets:consume-new-blank', () => ({ ok: true }))
  registerHandle('workbook:pending-edits', () => ({ ok: true }))

  // The renderer pings workbook:read-range to stream cells for the visible
  // viewport. We forward the call to the xlsx-sidecar (the same Rust binary
  // the Electron main process owns); the empty fallback only fires if the
  // sidecar is unreachable or the session expired.
  registerHandle('workbook:read-range', async (_event: unknown, request: unknown) => {
    const req = request as
      | {
          sessionId?: string
          sheetId?: string
          range?: { startRow: number; endRow: number; startColumn: number; endColumn: number }
        }
      | undefined
    const range = req?.range
    const rows = range ? range.endRow - range.startRow + 1 : 0
    if (!req?.sessionId || !req.sheetId || !range) {
      return emptyRange(range?.endRow ?? 0, rows)
    }
    try {
      const result = (await sheetsSidecar.readRange({
        sessionId: req.sessionId,
        sheetId: req.sheetId,
        range,
      })) as Record<string, unknown>
      return normalizeRangeResult(result, range.endRow)
    } catch (err) {
      // Sidecar session expired: the sidecar is per-process and resets on
      // process restart, so we may have lost the session. Return empty cells
      // rather than a hard error so the workbook metadata still shows up.
      console.warn('[sheets] read-range sidecar failed:', err)
      return emptyRange(range.endRow, rows)
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
      throw new InvalidArgumentError('workbook:open-for-merge', 'merge sources must be 1-20 files')
    }
    return paths.map((path) => {
      if (typeof path !== 'string' || !isManagedPath(path)) {
        throw new InvalidArgumentError('workbook:open-for-merge', PATH_OUTSIDE_STORAGE)
      }
      if (!existsSync(path)) {
        // A caller-supplied path that does not exist is a 404, not a server
        // fault: the renderer shows "file moved or deleted" for this case.
        throw new NotFoundError(
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
  //     with an unknown sessionId) gets a structured `NotFoundError`
  //     instead of the previous silently-accepted `{ok: false}`.

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
      throw new InvalidArgumentError(
        'workbook:save',
        'expects { sessionId: string, ... }',
      )
    }
    const session = getSession(req.sessionId)
    if (!session) {
      // A renderer that lost track of its sessionId (e.g. after the server
      // restarted) sees a clear error rather than a silent save success.
      throw new NotFoundError('workbook:save', `Unknown session: ${req.sessionId}`)
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

  registerHandle('workbook:save', async (_event: unknown, request: unknown) => {
    return runWorkbookSave({ request: (request ?? {}) as WorkbookSaveRequest })
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
      throw new NotFoundError(
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

  // auto-rename: the desktop main process watches edits and suggests a
  // fresh filename. The web build doesn't have enough signal to invent a
  // meaningful rename, so we return null (the renderer falls back to its
  // own heuristic) instead of fabricating a name.
  registerHandle('workbook:auto-rename', () => null)
}

function emptyRange(endRow: number, rows: number): Record<string, unknown> {
  return {
    cells: [],
    rows: Array.from({ length: Math.max(0, rows) }, (_, i) => ({
      row: Math.max(0, endRow - rows + 1) + i,
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
