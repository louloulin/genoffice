/**
 * Core slides lifecycle channels — new-blank, recent, open, open-path,
 * save, save-as, export-pdf, consume-pending-open, font-download/install,
 * insert-model3d. Persistence uses `slides-recent.json`.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { DOCS_RECENT, FILES_DIR, loadRecentSlides, registerHandle, requireManagedPath, saveRecentSlides, writeBlankOfficeFile, isManagedPath } from '../common/index'
import { recordRecentDoc } from '../common/document-stores'
import { notifyFileSaved } from '../common/webhooks-store'
import { sendIpcEvent } from '../common/event-broadcast'
import { captureBeforeSave } from '../common/version-history'
import { openPptx, savePptxToFile } from '@genoffice/pptx-engine'
import {
  registerSlidesSession,
  getSlidesSession,
  replaceSlidesSession,
  setSlidesDirty,
  forgetSlidesSession,
} from './state'

/** Path-keyed alias used by save-as when it migrates a session off its old
 *  source path. Keeps the call sites readable. */
function forgetSlidesSessionForPath(path: string): void {
  forgetSlidesSession(path)
}
import { buildRenderSlide, HeuristicMetrics } from '@genoffice/pptx-render'
import { parseTheme } from '@genoffice/pptx-engine'
import { displayMime } from '../../../slides/src/main/media-mime'
import { neutralizeJpegOrientation } from '../../../slides/src/main/jpeg-orientation'
import { tiffToPng } from '../../../slides/src/main/tiff-decode'
import type { OpenedPptx, Slide } from '@genoffice/pptx-engine'
import { CorruptError, InvalidArgumentError, NotFoundError } from '../ai/errors'
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import { StorageNotFoundError } from '@genoffice/file-management'
import { atomicWriteFile } from '../common/atomic'

function bytesFrom(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

function isManagedPptxPath(filePath: string): boolean {
  return /\.pptx$/i.test(filePath) && isManagedPath(filePath)
}

/** Mirror of the desktop `deckDefaultFont` in apps/slides/src/main/slides-main.ts:
 *  pull the deck's minor (body) Latin font from theme1.xml so the ribbon font box
 *  has something meaningful even before the user picks a selection. */
function deckDefaultFont(opened: OpenedPptx): string | undefined {
  try {
    const slidePath = opened.archive.readPresentation().slidePaths[0]
    if (!slidePath) return undefined
    const themePath = opened.archive.resolveSlideChain(slidePath).themePath
    const xml = themePath ? opened.archive.readText(themePath) : undefined
    return xml ? parseTheme(xml).minorFont : undefined
  } catch {
    return undefined
  }
}

/** web-server-only media resolver (no theme-tint rewrite, no electron deps).
 *  Decodes TIFF → PNG inline, neutralises EXIF orientation for JPEG, base64
 *  everything else as `data:` URLs the renderer can `<img src=>` directly. */
function makeWebMediaResolver(opened: OpenedPptx, _slidePath?: string) {
  const cache = new Map<string, string | undefined>()
  return (mediaRef: string): string | undefined => {
    if (cache.has(mediaRef)) return cache.get(mediaRef)
    const bytes = opened.archive.readBytes(mediaRef)
    let url: string | undefined
    if (bytes) {
      const mime = displayMime(mediaRef, bytes)
      if (mime === 'image/tiff') {
        const decoded = tiffToPng(bytes)
        if (decoded) url = `data:image/png;base64,${Buffer.from(decoded.png).toString('base64')}`
      } else {
        const served = mime === 'image/jpeg' ? neutralizeJpegOrientation(bytes) : bytes
        url = `data:${mime};base64,${Buffer.from(served).toString('base64')}`
      }
    }
    cache.set(mediaRef, url)
    return url
  }
}

/** Web-server renderer: deterministic heuristic metrics (no font parsing).
 *  Matches the desktop fallback when `createSystemFontMetrics` hasn't initialised. */
const webMetrics = new HeuristicMetrics()

function buildWebRenderSlides(opened: OpenedPptx, fitWidthPx: number) {
  return opened.deck.slides.map((s: Slide, i: number) =>
    buildRenderSlide(s, opened.deck.size, {
      fitWidthPx,
      media: makeWebMediaResolver(opened, s.path),
      metrics: webMetrics,
      slideNo: i + 1,
    }),
  )
}

/** Default slide canvas width used when the renderer doesn't pass `fitWidthPx`.
 *  Matches the desktop default (`FIT_WIDTH = 1280` in apps/slides). */
const DEFAULT_FIT_WIDTH = 1280

export function registerSlidesCoreHandlers(): void {
  registerHandle('slides:new-blank', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = `演示文稿-${new Date().toLocaleDateString()}.pptx`
    const path = join(FILES_DIR, `${id}.pptx`)

    if (opts?.pptx) {
      writeFileSync(path, Buffer.from(opts.pptx))
    } else if (opts?.path) {
      /* Caller supplied a path but no bytes (e.g. caller already wrote the
       * file via a different channel). Trust the path; do not overwrite. */
    } else {
      /* No bytes, no path: the renderer fired the channel from its boot
       * "give me a blank deck" path. Materialise a real, openable file
       * from the embedded template so the recents row we are about to
       * append actually points at a file on disk. Without this fallback
       * every cold-start click left a "missing" tile in the home grid. */
      writeBlankOfficeFile('pptx', path)
    }

    const recent = loadRecentSlides()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSlides(recent)
    /* Mirror into the unified store so home:recents (the home grid uses
     * unifiedRecents) surfaces this row. Without the mirror every
     * cold-start click is invisible to the home tile, even though the
     * file actually exists at `path`. recordRecentDoc is fire-and-forget
     * safe: failures are absorbed by the debounced writer. */
    void recordRecentDoc(path, { id, name, modified: false })

    return {
      path: '',
      slides: [
        {
          widthPx: 1280,
          heightPx: 720,
          scale: 1,
          background: { kind: 'solid', color: '#FFFFFF' },
          nodes: [],
        },
      ],
      size: { cx: 12192000, cy: 6858000 },
      defaultFont: 'Aptos',
    }
  })

  registerHandle('slides:recent', () => loadRecentSlides())

  registerHandle('slides:open', async (_event: unknown, options: unknown) => {
    const opts = options as { pptx?: ArrayBuffer; path?: string } | undefined
    const id = `slide-${Date.now()}`
    const name = opts?.path ? basename(opts.path) : `演示文稿-${Date.now()}.pptx`

    return { id, path: opts?.path || '', name }
  })

  registerHandle('slides:open-path', async (_event: unknown, filePath: unknown) => {
    // A non-string `filePath` is a renderer-side mistake (the channel
    // contract is "string path"), not a missing resource. Throwing
    // `InvalidArgumentError` (400) keeps the failure mode consistent with
    // `docs:open-path` / `workbook:open-path`, which the e2e guard test
    // exercises by sending `{ filePath: canary }` to every open-path
    // channel and asserting each one answers 400.
    if (typeof filePath !== 'string') {
      throw new InvalidArgumentError('slides:open-path', 'path must be a string')
    }
    const key = storageKeyFromPath(filePath)
    const canonical = key ? join(FILES_DIR, key) : null
    let bytes: Buffer
    if (key) {
      // Storage-backed uploads (`storage://<backend>/<key>`) used to bounce
      // here with a 400 because requireManagedPath only accepts filesystem
      // paths. The home recents row carries the storage URI; without this
      // branch clicking it surfaced "path is outside the web storage area".
      try {
        const u8 = await getStorageBackend().get(key)
        bytes = Buffer.from(u8)
      } catch (err) {
        if (err instanceof StorageNotFoundError) {
          throw new NotFoundError('slides:open-path', `File not found: ${filePath}`)
        }
        throw err
      }
    } else {
      const path = requireManagedPath('slides:open-path', filePath)
      if (!existsSync(path)) {
        throw new NotFoundError('slides:open-path', `File not found: ${path}`)
      }
      bytes = readFileSync(path)
    }
    const path = canonical ?? filePath
    // Prefer the display name already recorded by `web:save-file` so the
    // slides recents entry carries the user's filename (e.g.
    // "Quarterly.pptx") instead of the storage-hash basename. Falls back
    // to basename(path) for legacy callers (direct FILES_DIR paths).
    const name = DOCS_RECENT.get(filePath)?.name ?? basename(path)
    const id = `slide-${Date.now()}`

    // Match the desktop `slides:open-path` shape: parse the pptx via `@genoffice/pptx-engine`
    // and return the same `{path, slides, size, defaultFont}` the renderer expects. Without
    // this the web renderer keeps `slides` as `undefined` and the boot screen never goes
    // away. Uses the web-only helpers above so we avoid the harfbuzz wasm + electron
    // deps that the desktop `render-helpers.ts` transitively pulls in.
    // A file that is not a pptx is a client-side problem (422), not a server
    // fault: the parse used to throw out of the handler as an unhandled 500.
    let opened: Awaited<ReturnType<typeof openPptx>>
    try {
      opened = await openPptx(new Uint8Array(bytes))
    } catch (err) {
      throw new CorruptError(
        'slides:open-path',
        `Failed to parse deck: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    // Recorded only now that the deck actually parses: a corrupt file used to
    // reach the recents list and then fail, so "recently opened" listed decks
    // that never opened.
    const recent = loadRecentSlides()
    recent.unshift({ id, path, name, openedAt: Date.now() })
    saveRecentSlides(recent)

    const slides = buildWebRenderSlides(opened, DEFAULT_FIT_WIDTH)

    // Register the live `OpenedPptx` so `slides:save` and `slides:apply-txn`
    // have something to mutate. Without this the save pipeline reads bytes
    // the renderer no longer holds and every save either no-ops or answers
    // `WEB_UNSUPPORTED`. We also keep `path` (the renderer-visible path)
    // as the registry key, NOT `bytes`'s storage URI — a renderer that
    // re-opens the same logical file with a different URI (e.g. after a
    // save-as) would otherwise see a stale model.
    registerSlidesSession(path, opened)

    return {
      path,
      slides,
      size: { cx: opened.deck.size.cx, cy: opened.deck.size.cy },
      defaultFont: deckDefaultFont(opened),
    }
  })

  // ── Save ───────────────────────────────────────────────────────────────
  // The desktop main process is the authority for a deck: the renderer streams
  // `slides:apply-txn` ops and main mutates the parsed `OpenedPptx`, so
  // `savePptxToFile` can serialize the user's edits from that model. The web
  // build has no such model — the element/edit channels are acknowledged as
  // no-ops and the renderer never hands over pptx bytes — so a save here cannot
  // serialize anything.
  //
  // The handlers below still accept bytes for a future renderer-side
  // serialization, but answer honestly when none arrive. Previously they
  // reported `{ ok: true }` while writing nothing (showing a "已保存" toast and
  // silently discarding the deck), and `slides:save-as` replied without an `ok`
  // field at all, so the renderer classified a save-as as neither success nor
  // failure and did nothing whatsoever.
  const WEB_SAVE_UNSUPPORTED =
    'WEB_UNSUPPORTED: web 版暂不支持保存编辑后的 PPTX（渲染层编辑尚未同步到服务器模型）'

  registerHandle(
    'slides:save',
    async (event: unknown, _id?: unknown, path?: unknown, data?: unknown) => {
      if (typeof path !== 'string' || !path) {
        return { ok: false, canceled: true, error: 'slides:save expects { path: string }' }
      }
      const key = storageKeyFromPath(path)
      const canonical = key ? join(FILES_DIR, key) : path
      if (!key && !isManagedPptxPath(canonical)) {
        // The old handler wrote to ANY path the renderer named, including
        // `/tmp/anywhere.pptx`. With `requireManagedPath` semantics the
        // storage URI branch is the only escape hatch the recents grid needs.
        return { ok: false, error: 'save target is outside the web storage area' }
      }

      // Two valid save flows:
      //   1. The renderer hands over pptx bytes (`data` is an ArrayBuffer /
      //      Uint8Array). Write them straight to disk / storage backend.
      //      This is the path the renderer's web-bridge uses when it
      //      already serialised locally.
      //   2. The renderer passes no bytes. Serialise the registered
      //      `OpenedPptx` via `@genoffice/pptx-engine`'s `savePptxToFile`
      //      — this is the path the desktop main process has used since
      //      the desktop-save refactor and is the only one that round-trips
      //      a deck whose edits the renderer streamed through
      //      `slides:apply-txn`.
      try {
        if (data !== undefined && data !== null) {
          const bytes = bytesFrom(data)
          if (!bytes || bytes.byteLength === 0) {
            return { ok: false, error: 'save data is empty or invalid' }
          }
          if (key) {
            // Snapshot prior bytes BEFORE the storage put so the renderer can
            // roll back via files:restore-version. Storage URIs are not
            // restorable directly (we never read the key back through the
            // kernel) so capture is a no-op for that branch.
            try {
              const prev = readFileSync(canonical)
              captureBeforeSave(basename(canonical), prev)
            } catch { /* new file or storage-backed, nothing to snapshot */ }
            await getStorageBackend().put(key, new Uint8Array(bytes), {
              contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            })
          } else {
            // Snapshot prior bytes BEFORE the atomic write so the renderer can
            // roll back via files:restore-version.
            try {
              const prev = readFileSync(canonical)
              captureBeforeSave(basename(canonical), prev)
            } catch { /* new file, nothing to snapshot */ }
            mkdirSync(dirname(canonical), { recursive: true })
            atomicWriteFile(canonical, bytes)
          }
          notifyFileSaved(canonical, { size: bytes.byteLength, format: 'pptx' })
          sendIpcEvent(event, 'saved', {
            path: canonical,
            version: Date.now(),
            bytes: bytes.byteLength,
            format: 'pptx',
          })
          return { ok: true, path: canonical }
        }

        // No bytes: serialise the live model. The registry must have the
        // session; otherwise the renderer never opened the deck (or the
        // server restarted) and the save is unanswerable.
        const session = getSlidesSession(canonical)
        if (!session) {
          return {
            ok: false,
            canceled: true,
            error: 'slides:save: no live model for this path — re-open the deck first',
          }
        }
        mkdirSync(dirname(canonical), { recursive: true })
        // Snapshot the existing deck bytes so the renderer can roll back
        // via files:restore-version. Read before savePptxToFile overwrites.
        try {
          const prev = readFileSync(canonical)
          captureBeforeSave(basename(canonical), prev)
        } catch { /* new file, nothing to snapshot */ }
        await savePptxToFile(session.opened, canonical)
        // Clear the dirty flag: the on-disk bytes now match the model.
        setSlidesDirty(canonical, false)
        // Surface the save through SSE so embed consumers can update
        // their `dirty` UI state. Bytes comes from statSync because the
        // live model path doesn't keep a handle on the buffer.
        try {
          const st = statSync(canonical)
          sendIpcEvent(event, 'saved', {
            path: canonical,
            version: Date.now(),
            bytes: st.size,
            format: 'pptx',
          })
        } catch { /* missing file is unexpected here, swallow */ }
        return { ok: true, path: canonical }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    },
  )

  registerHandle(
    'slides:save-as',
    async (_event: unknown, defaultName?: unknown, data?: unknown, sourcePath?: unknown) => {
      // Save-as needs a source path to find the registered session, OR
      // explicit bytes from the renderer. A bare "save-as with neither"
      // used to return `WEB_UNSUPPORTED`; now it answers an explicit
      // invalid-argument so the renderer can branch correctly.
      if (data === undefined || data === null) {
        if (typeof sourcePath !== 'string' || !sourcePath) {
          return {
            ok: false,
            canceled: true,
            error: 'slides:save-as expects { sourcePath: string } when no bytes are supplied',
          }
        }
        const sourceSession = getSlidesSession(sourcePath)
        if (!sourceSession) {
          return {
            ok: false,
            canceled: true,
            error: 'slides:save-as: no live model for sourcePath — re-open the deck first',
          }
        }
        const id = `slide-${Date.now()}`
        const name =
          (typeof defaultName === 'string' && defaultName) || `演示文稿.pptx`
        const targetPath = join(FILES_DIR, `${id}.pptx`)
        mkdirSync(FILES_DIR, { recursive: true })
        await savePptxToFile(sourceSession.opened, targetPath)
        // Move the registry entry to the new path so subsequent edits /
        // saves follow the new file rather than the old one.
        replaceSlidesSession(targetPath, sourceSession.opened)
        setSlidesDirty(targetPath, false)
        forgetSlidesSessionForPath(sourcePath)
        return { id, name, ok: true, path: targetPath }
      }

      // Byte-driven save-as (renderer serialised locally). Write to a fresh
      // managed file under FILES_DIR.
      const id = `slide-${Date.now()}`
      const name = (typeof defaultName === 'string' && defaultName) || `演示文稿.pptx`
      const path = join(FILES_DIR, `${id}.pptx`)
      mkdirSync(FILES_DIR, { recursive: true })
      writeFileSync(path, Buffer.from(data as ArrayBuffer))
      return { id, name, ok: true, path }
    },
  )

  // ── Export images ──────────────────────────────────────────────────────
  // The renderer rasterizes each visible slide to a base64 PNG in-browser (it
  // owns the canvas) and ships the batch here, so this channel needs no deck
  // model and is fully supported in the web build. Desktop parity:
  // `slides:export-images` in apps/slides/src/main/slides-main.ts. This channel
  // used to be unregistered, which made the renderer's export click 404.
  registerHandle('slides:export-images', async (_event: unknown, op: unknown) => {
    const request = (op || {}) as { dir?: unknown; baseName?: unknown; pngsBase64?: unknown }
    if (typeof request.dir !== 'string' || !Array.isArray(request.pngsBase64)) {
      return { ok: false, error: 'slides:export-images expects { dir, baseName, pngsBase64 }' }
    }
    const rawBase = typeof request.baseName === 'string' && request.baseName ? request.baseName : 'slide'
    // baseName reaches us straight from the deck's file name; strip separators,
    // traversal runs and leading dots so a crafted name cannot escape the
    // export dir (the resolve/prefix check below is the hard backstop).
    const safeBase =
      rawBase
        .replace(/\.\.+/g, '_')
        .replace(/[/\\:*?"<>|]+/g, '_')
        .replace(/^[.\s]+/, '') || 'slide'
    try {
      const root = resolve(request.dir)
      mkdirSync(root, { recursive: true })
      // Zero-padding width follows the total page count (3 digits for ≥100 pages).
      const pad = request.pngsBase64.length >= 100 ? 3 : 2
      const paths: string[] = []
      for (let i = 0; i < request.pngsBase64.length; i++) {
        const target = resolve(root, `${safeBase}-${String(i + 1).padStart(pad, '0')}.png`)
        if (!target.startsWith(root + sep)) {
          return { ok: false, error: 'slides:export-images: target escapes the export dir' }
        }
        writeFileSync(target, Buffer.from(String(request.pngsBase64[i]), 'base64'))
        paths.push(target)
      }
      return { ok: true, paths }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  registerHandle('slides:export-pdf', () => ({
    ok: true,
    message: '请使用浏览器的打印功能导出 PDF',
  }))

  registerHandle('slides:consume-pending-open', () => null)
  registerHandle('slides:autosave-pref', () => undefined)

  registerHandle('slides:font-download', () => ({
    ok: true,
    message: 'Web 版本不支持字体下载',
  }))

  registerHandle('slides:font-install-local', () => ({ ok: true }))

  registerHandle('slides:insert-model3d', () => ({ ok: true }))
}
