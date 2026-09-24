/**
 * Home (start page) channels — recents, starred, theme/language, account
 * status, analytics, update-channel, onboarding, github stars, stat paths,
 * browse, new-{doc/sheet/slide/markdown/pdf}, delete/rename/duplicate, reveal,
 * open-trash, cloud-projects. The recents and starred sets share the maps
 * declared in `common/state.ts` (`DOCS_RECENT`, `DOCS_STARRED`).
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'

/**
 * Web-only preferences store. The Electron main process persists these in
 * `app-settings.json`; the web build uses its own atomic JSON file at
 * `<DATA_DIR>/preferences.json`. Atomic writes (write-temp + rename) keep
 * the file crash-safe; the cache (`prefCache`) avoids re-reading the JSON
 * on every channel call. Settings read at startup use the cache so the
 * shell renderer's `Promise.all([getLanguage, onboardingSeen, getTheme])`
 * sees the persisted values without a disk hit on the second call.
 */
type Preferences = {
  theme?: 'light' | 'dark' | 'system'
  cloudOpenMode?: 'tab' | 'window' | 'external'
  language?: string
}

const PREFERENCES_FILE = join(DATA_DIR, 'preferences.json')
let prefCache: Preferences | null = null

function readPreferences(): Preferences {
  if (prefCache) return prefCache
  try {
    if (existsSync(PREFERENCES_FILE)) {
      const parsed = JSON.parse(readFileSync(PREFERENCES_FILE, 'utf8'))
      prefCache = (parsed && typeof parsed === 'object') ? parsed as Preferences : {}
    } else {
      prefCache = {}
    }
  } catch {
    /* A corrupt preferences file is a defect but not fatal — fall back to
     * defaults so the home page still renders. The next write will
     * overwrite the broken file with a valid one. */
    prefCache = {}
  }
  return prefCache!
}

function writePreferences(prefs: Preferences): void {
  prefCache = prefs
  try {
    const tmp = `${PREFERENCES_FILE}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8')
    renameSync(tmp, PREFERENCES_FILE)
  } catch {
    /* Preference persistence is best-effort: a failing disk must not block
     * the renderer from updating its in-memory copy or applying the change
     * for the current session. */
  }
}

/** Map a DocInfo record to the RecentEntry shape the home renderer expects,
 *  stat-ing the file for size/mtime. Files that fail to stat are flagged
 *  `missing` instead of being dropped (mirrors the desktop behaviour). */
async function toRecentEntry(d: {
  id: string
  path: string
  name: string
  openedAt?: number
  modified?: boolean
}): Promise<{
  path: string
  name: string
  ext: string
  mtimeMs: number
  sizeBytes: number
  modified: boolean
  starred: boolean
  missing?: boolean
}> {
  const ext =
    d.path
      .split(/[\\./]/)
      .pop()
      ?.toLowerCase() ?? ''
  /* Storage-backed URIs (`storage://<backend>/<key>`) go through the
   * active backend so MinIO/S3/rustfs files surface with the same
   * shape as a local file. The legacy fs path keeps its previous
   * behaviour for absolute paths. */
  const key = storageKeyFromPath(d.path)
  if (key) {
    try {
      const head = await getStorageBackend().head(key)
      if (head.exists) {
        return {
          path: d.path,
          name: d.name,
          ext,
          mtimeMs: head.modifiedAt ? Date.parse(head.modifiedAt) : Date.now(),
          sizeBytes: Number(head.size),
          modified: d.modified ?? false,
          starred: DOCS_STARRED.has(d.path),
        }
      }
    } catch {
      /* fall through to missing */
    }
    return {
      path: d.path,
      name: d.name,
      ext,
      mtimeMs: d.openedAt ?? 0,
      sizeBytes: 0,
      modified: d.modified ?? false,
      starred: DOCS_STARRED.has(d.path),
      missing: true,
    }
  }
  try {
    if (existsSync(d.path)) {
      const s = statSync(d.path)
      return {
        path: d.path,
        name: d.name,
        ext,
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
        // The renderer draws a modified indicator next to a recently
        // saved file. The flag comes from `recordRecentDoc({modified})`
        // (see docs:save / markdown:save / sheets:save); absent it means
        // the file is freshly opened but not yet edited.
        modified: d.modified ?? false,
        starred: DOCS_STARRED.has(d.path),
      }
    }
  } catch {}
  return {
    path: d.path,
    name: d.name,
    ext,
    mtimeMs: d.openedAt ?? 0,
    sizeBytes: 0,
    modified: d.modified ?? false,
    starred: DOCS_STARRED.has(d.path),
    missing: true,
  }
}

import { basename, dirname, extname, join } from 'node:path'
import {
  DATA_DIR,
  DOCS_RECENT,
  DOCS_STARRED,
  FILES_DIR,
  isManagedPath,
  PATH_OUTSIDE_STORAGE,
  registerHandle,
  saveStarredDocs,
} from '../common/index'
import { atomicWriteFile } from '../common/atomic'
import { getStorageBackend, storageKeyFromPath } from '../common/state'
import {
  forgetRecentDoc,
  mirrorRecentDoc,
  recordRecentDoc,
  trash,
  unifiedRecents,
} from '../common/document-stores'
import { readBlankTemplate } from '../common/blank-templates'
import { setupRecentsFileWatcher } from './recents-watcher'

/**
 * Mirror a recents change into the legacy in-session `DOCS_RECENT` map.
 *
 * Thin wrapper over the shared helpers in `common/document-stores` so the
 * legacy mirror can never drift from `unifiedRecents`, which is what makes
 * the list survive a restart.
 */
function mirrorRecent(path: string, action: 'add' | 'remove'): void {
  if (action === 'add') mirrorRecentDoc(path, { name: basename(path) })
  else forgetRecentDoc(path)
}

/* ── Blank file templates ────────────────────────────────────────────
 * A new docx/xlsx/pptx must round-trip through the matching renderer before
 * the user types anything, and each renderer validates the zip magic +
 * Content_Types on open. An empty file or a fresh `home:new-*` path that
 * never existed on disk used to land the renderer on a parse error
 * (markdown) or an empty grid (sheets), neither of which matched the
 * recents entry the renderer was just handed. Writing a known-good
 * minimal zip from an embedded template makes the recents entry
 * accurate and the first paint a real empty document. */
/* Renderer-supplied id lets the web bridge `window.open` the editor URL
 * synchronously inside the click handler (so the popup grant window is
 * still open and the navigate is not silently dropped). Trust the
 * renderer's id only if it matches the expected prefix and a safe
 * character set; otherwise fall back to the timestamp so a misbehaving
 * caller cannot write outside FILES_DIR / DATA_DIR. */
function pickRendererId(args: unknown, prefix: string): string {
  const candidate =
    args && typeof args === 'object' && typeof (args as { id?: unknown }).id === 'string'
      ? (args as { id: string }).id
      : ''
  if (candidate && new RegExp(`^${prefix}-[A-Za-z0-9._-]+$`).test(candidate)) {
    return candidate
  }
  return `${prefix}-${Date.now()}`
}

export function registerHomeHandlers(): void {
  /* A file dropped into FILES_DIR by anything other than our own save
   * channels (drag-and-drop, `mv`, a sync client) must still reach the home
   * grid, so the directory is watched and every addition mirrored into both
   * recents stores. */
  setupRecentsFileWatcher({
    filesDir: FILES_DIR,
    recents: unifiedRecents,
    onAdded: (path) => mirrorRecent(path, 'add'),
    onRemoved: (path) => mirrorRecent(path, 'remove'),
  })

  registerHandle('home:get-app-version', () => '1.0.0')

  /* Expose the resolved data / file roots so the web renderer can predict
   * the exact path of a freshly-created blank file in a single synchronous
   * window.open(url) call. Without this, the quick-start cards have to
   * open an about:blank tab and navigate it after awaiting IPC, which
   * browsers silently drop because the navigate happens outside the user
   * gesture stack and after the popup grant window has already closed. */
  registerHandle('home:get-data-paths', () => ({ dataDir: DATA_DIR, filesDir: FILES_DIR }))

  registerHandle('home:get-theme', () => {
    const prefs = readPreferences()
    return prefs.theme || 'system'
  })
  registerHandle('home:set-theme', (_event: unknown, theme: unknown) => {
    /* Whitelist: the renderer (and `applyTheme` in SettingsModal) only
     * emit 'light' | 'dark' | 'system'; anything else falls back to the
     * current value rather than persisting garbage. */
    const allowed = ['light', 'dark', 'system'] as const
    type Allowed = typeof allowed[number]
    const next: Allowed = (allowed as readonly string[]).includes(String(theme))
      ? (theme as Allowed)
      : readPreferences().theme || 'system'
    const prefs = readPreferences()
    prefs.theme = next
    writePreferences(prefs)
    return { ok: true, theme: next }
  }, { scope: 'soft:preferences:write' })

  registerHandle('home:get-language', () => 'zh-CN')
  registerHandle('home:set-language', (_event: unknown, lang: unknown) => ({
    ok: true,
    language: lang,
  }), { scope: 'soft:preferences:write' })

  /* Cloud-open-mode: how the renderer should open a file picked from the
   * cloud (e.g. download, recents cloud row). The renderer reads this from
   * Settings → Integrations on mount and broadcasts changes via
   * home:set-cloud-open-mode + 'app:cloud-open-mode-changed'. The Electron
   * main process persists the choice in app-settings.json; the web build
   * keeps it in memory + on-disk JSON so a restart keeps the user's pick.
   * Without these two handlers, the Settings dialog throws
   * `IpcBridgeError: No handler for 'home:get-cloud-open-mode'` every time
   * it mounts, which is the console error the renderer logs on every
   * open. */
  registerHandle('home:get-cloud-open-mode', () => ({ mode: readPreferences().cloudOpenMode || 'tab' }))
  registerHandle('home:set-cloud-open-mode', (_event: unknown, mode: unknown) => {
    const allowed = ['tab', 'window', 'external'] as const
    type Allowed = typeof allowed[number]
    const next: Allowed = (allowed as readonly string[]).includes(String(mode))
      ? (mode as Allowed)
      : 'tab'
    const prefs = readPreferences()
    prefs.cloudOpenMode = next
    writePreferences(prefs)
    return { ok: true, mode: next }
  }, { scope: 'soft:preferences:write' })

  registerHandle('home:recents', async (_event: unknown, args: unknown) => {
    const {
      offset = 0,
      limit = 50,
      ext,
    } = (args || {}) as { offset?: number; limit?: number; ext?: string }
    /* `unifiedRecents` is the restart-safe list; `DOCS_RECENT` is the legacy
     * in-session mirror. Reading only the mirror meant a restart silently
     * truncated the grid to whatever the mirror's on-disk file happened to
     * hold (it is capped at ten rows), so documents the user had uploaded
     * disappeared on the next boot. The mirror is still merged in so an entry
     * written before this change stays visible, but the union is keyed by
     * path so a row present in both is not shown twice. */
    const merged = new Map<
      string,
      { id: string; path: string; name: string; openedAt?: number; modified?: boolean }
    >()
    for (const entry of unifiedRecents.list()) {
      merged.set(entry.path, {
        id: entry.id,
        path: entry.path,
        name: entry.name,
        openedAt: entry.openedAt,
        modified: entry.modified,
      })
    }
    for (const doc of DOCS_RECENT.values()) {
      /* The mirror never wins a name: it is populated from the generated
       * on-disk basename in some paths, while the store keeps the name the
       * save channel recorded. */
      if (!merged.has(doc.path)) merged.set(doc.path, doc)
    }
    const all = [...merged.values()]
    const filtered = ext
      ? all.filter((d) => d.path.toLowerCase().endsWith('.' + ext.toLowerCase()))
      : all
    /* Newest first, so the union order does not depend on Map insertion. */
    filtered.sort((a, b) => (b.openedAt ?? 0) - (a.openedAt ?? 0))
    const sliced = filtered.slice(offset, offset + limit)
    const entries = await Promise.all(sliced.map((d) => toRecentEntry(d)))
    return {
      entries,
      total: filtered.length,
      totalAll: all.length,
    }
  })

  registerHandle('home:starred', async (_event: unknown, args: unknown) => {
    const {
      offset = 0,
      limit = 50,
      ext,
    } = (args || {}) as { offset?: number; limit?: number; ext?: string }
    // DOCS_STARRED is now a Map<path, starredAt>; spread the keys, then
    // resolve against DOCS_RECENT to attach the user-visible fields.
    const all = Array.from(DOCS_STARRED.keys())
      .map((p) => DOCS_RECENT.get(p))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
    const filtered = ext ? all.filter((d) => d.path.toLowerCase().endsWith('.' + ext)) : all
    const sliced = filtered.slice(offset, offset + limit)
    const entries = await Promise.all(sliced.map((d) => toRecentEntry(d)))
    return {
      entries,
      total: filtered.length,
      totalAll: all.length,
    }
  })

  registerHandle('home:toggle-star', (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !path) return { starred: false }
    let starred: boolean
    if (DOCS_STARRED.has(path)) {
      DOCS_STARRED.delete(path)
      starred = false
    } else {
      DOCS_STARRED.set(path, Date.now())
      starred = true
    }
    // Persist immediately so a restart does not silently un-star. The Map
    // may have been re-seeded by `initRecentState()` from a previous session;
    // saving the full snapshot keeps the home pane consistent across reboots.
    try {
      saveStarredDocs(DOCS_STARRED)
    } catch (error) {
      console.warn('[home] failed to save starred docs:', error)
    }
    return { starred }
  })

  registerHandle('home:open-path', async (_event: unknown, path: unknown) => {
    if (typeof path !== 'string') return { ok: false, error: 'invalid path' }
    return { ok: true, path, opened: true }
  })

  registerHandle('home:remove-recent', (_event: unknown, paths: unknown) => {
    if (!Array.isArray(paths)) return { ok: false, removed: 0 }
    paths.forEach((p) => DOCS_RECENT.delete(p))
    return { ok: true, removed: paths.length }
  }, { scope: 'soft:files:write' })

  registerHandle('home:delete-files', async (_event: unknown, paths: unknown) => {
    const values = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    const refused: string[] = []
    let deleted = 0
    for (const path of values) {
      // Refuse anything outside managed storage before touching the disk; this
      // loop used to unlink any path handed to it. Out-of-storage paths are
      // reported back instead of being silently skipped.
      if (!isManagedPath(path)) {
        refused.push(path)
        continue
      }
      // Soft delete: the file moves into `.trash/` with an index entry, so a
      // mis-click is recoverable through home:restore-from-trash. The previous
      // `unlinkSync` destroyed the document outright.
      /* The Trash backend moved from sync rename to async
       * (storage.get/put/delete) so remote buckets get the right
       * semantics. Await before reporting success. */
      if (await trash.delete(path)) {
        deleted += 1
        /* Drop the path from both the in-session mirror and the restart-safe
         * store, or the home grid keeps offering a row for a file the user
         * just deleted. Awaited so the caller cannot observe it as still
         * present. */
        forgetRecentDoc(path)
        await unifiedRecents.remove(path)
      }
    }
    // `deleted` is the count that actually happened, not the count requested.
    return refused.length > 0
      ? { ok: refused.length < values.length, deleted, refused }
      : { ok: true, deleted }
  }, { scope: 'soft:files:delete' })

  registerHandle('home:duplicate-file', async (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !isManagedPath(path))
      return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (!existsSync(path)) return { ok: false, error: 'File not found' }
    const dir = dirname(path)
    const ext = extname(path)
    const base = basename(path, ext)
    /* `name-copy.docx`, then `name-copy (2).docx`, `(3)` … The first duplicate
     * used to be a fixed `-copy` name, so duplicating twice silently
     * overwrote the first copy — destroying the file the user had just made. */
    let newPath = join(dir, `${base}-copy${ext}`)
    for (let n = 2; existsSync(newPath); n += 1) {
      newPath = join(dir, `${base}-copy (${n})${ext}`)
    }
    atomicWriteFile(newPath, readFileSync(path))
    void unifiedRecents.add(newPath, { name: basename(newPath), modified: true })
    return { ok: true, path: newPath }
  })

  registerHandle('home:rename-file', async (_event: unknown, path: unknown, newName: unknown) => {
    if (typeof path !== 'string' || !isManagedPath(path))
      return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (typeof newName !== 'string') return { ok: false, error: 'invalid file name' }
    /* A bare file name only: a separator or `..` in `newName` would move the
     * file out of its directory, and out of managed storage. Every check below
     * runs before any filesystem call, and the source is never touched on a
     * rejection — the caller reports `ok: false` and the file stays put. */
    if (newName.length === 0 || newName.length > 255 || newName === '.' || newName === '..') {
      return { ok: false, error: 'invalid file name' }
    }
    if (basename(newName) !== newName) return { ok: false, error: 'invalid file name' }
    /* A NUL or short control char in a name truncates the path at the syscall
     * boundary or corrupts the dirent, so it is rejected before any fs call. */
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(newName)) return { ok: false, error: 'invalid file name' }
    if (!existsSync(path)) return { ok: false, error: 'File not found' }
    const newPath = join(dirname(path), newName)
    if (!isManagedPath(newPath)) return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (newPath !== path && existsSync(newPath)) {
      /* Refusing beats clobbering: the destination holds a different document
       * that the user did not ask to lose. */
      return { ok: false, error: 'a file with that name already exists' }
    }
    renameSync(path, newPath)
    /* The recents row has to follow the file, or the home grid keeps pointing
     * at a path that no longer exists. */
    void unifiedRecents.rename(path, newPath)
    return { ok: true, path: newPath }
  })

  registerHandle('home:reveal-path', (_event: unknown, path: unknown) => {
    return { ok: true, path }
  })

  registerHandle('home:open-trash', () => ({ ok: true }))

  registerHandle('home:new-doc', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'doc')
    const path = join(FILES_DIR, `${id}.docx`)
    /* Drop a known-good minimal docx on disk so docs:open-path can parse
     * it on the first IPC round-trip. Without this write the docs app's
     * catch path would still recover via newFile(), but the recents row
     * would point at a path the user never saved to — the path the
     * renderer actually wrote back to would be a different timestamp. */
    try {
      const tpl = readBlankTemplate('docx')
      if (tpl) writeFileSync(path, tpl)
    } catch {
      /* read-only storage: keep the recents entry anyway */
    }
    await recordRecentDoc(path, { id, name: `${id}.docx`, modified: false })
    return { id, path }
  })

  registerHandle('home:new-sheet', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'sheet')
    const path = join(FILES_DIR, `${id}.xlsx`)
    /* Pre-write a known-good minimal xlsx so workbook:open-path's xlsx
     * sidecar parses it on the first try. The sheets app has no
     * NotFoundError fallback (the open failure surfaces as a status-bar
     * error), so the file has to be real from the start. */
    try {
      const tpl = readBlankTemplate('xlsx')
      if (tpl) writeFileSync(path, tpl)
    } catch {
      /* read-only storage: keep the recents entry anyway */
    }
    await recordRecentDoc(path, { id, name: `${id}.xlsx`, modified: false })
    return { id, path }
  })

  registerHandle('home:new-slide', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'slide')
    const path = join(FILES_DIR, `${id}.pptx`)
    /* Pre-write a known-good minimal pptx so the slides renderer boots
     * onto a real empty deck (consistent with new-pdf / new-html). */
    try {
      const tpl = readBlankTemplate('pptx')
      if (tpl) writeFileSync(path, tpl)
    } catch {
      /* read-only storage: keep the recents entry anyway */
    }
    await recordRecentDoc(path, { id, name: `${id}.pptx`, modified: false })
    return { id, path }
  })

  registerHandle('home:new-markdown', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'md')
    const path = join(FILES_DIR, `${id}.md`)
    // Markdown is plain text, so an actual empty file on disk is safe to
    // open (parseDocText returns an empty envelope). Without this write,
    // the markdown app boots, calls markdown:read-file, hits a 404, and
    // shows "文件打开失败" — the user has to re-pick the file from recents.
    try {
      writeFileSync(path, '', 'utf-8')
    } catch {
      /* read-only storage: keep the recents entry anyway */
    }
    await recordRecentDoc(path, { id, name: `${id}.md`, modified: false })
    return { id, path }
  })

  registerHandle('home:new-pdf', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'pdf')
    const path = join(FILES_DIR, `${id}.pdf`)
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << >> >>\nendobj\n',
      '4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
    ]
    let pdf = '%PDF-1.4\n'
    const offsets = [0]
    for (const object of objects) {
      offsets.push(Buffer.byteLength(pdf, 'binary'))
      pdf += object
    }
    const xrefOffset = Buffer.byteLength(pdf, 'binary')
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    writeFileSync(path, Buffer.from(pdf, 'binary'))
    await recordRecentDoc(path, { id, name: `${id}.pdf`, modified: false })
    return { id, path }
  })

  registerHandle('home:new-html', async (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'html')
    const path = join(DATA_DIR, `${id}.html`)
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>新 HTML 文档</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 720px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 32px; font-weight: 600; }
    .meta { color: #6b7280; font-size: 14px; }
  </style>
</head>
<body>
  <h1>新 HTML 文档</h1>
  <p class="meta">由 GenOffice 创建</p>
  <p>开始编辑你的 HTML 内容...</p>
</body>
</html>
`
    writeFileSync(path, html, 'utf-8')
    await recordRecentDoc(path, { id, name: `${id}.html`, modified: false })
    return { id, path }
  })

  /* Web build ships without a real login backend; surface a friendly
   * placeholder identity so the user chip + sidebar account block have
   * something to render. The renderer displays `email.split('@')[0]` as the
   * username, so the local-part is the visible name. Loaded from a small
   * JSON file when present so the user can rename themselves across
   * sessions; falls back to a sensible default. */
  const WEB_ACCOUNT_FILE = join(DATA_DIR, 'web-account.json')
  function loadWebAccount(): typeof WEB_ACCOUNT {
    try {
      if (existsSync(WEB_ACCOUNT_FILE)) {
        const raw = JSON.parse(readFileSync(WEB_ACCOUNT_FILE, 'utf-8'))
        if (raw && typeof raw.email === 'string') return { ...WEB_ACCOUNT, ...raw }
      }
    } catch {}
    return WEB_ACCOUNT
  }
  const WEB_ACCOUNT = {
    loggedIn: true,
    email: 'godlinchong@genoffice.ai',
    displayName: 'godlinchong',
    plan: 'pro',
    creditBalance: 1000,
  }
  registerHandle('home:account-status', () => loadWebAccount())
  registerHandle('home:account-set-name', (_event: unknown, name: unknown) => {
    if (typeof name !== 'string' || !name.trim()) return { ok: false }
    const clean = name.trim().slice(0, 64)
    const next = { ...loadWebAccount(), displayName: clean, email: clean + '@genoffice.ai' }
    try {
      writeFileSync(
        WEB_ACCOUNT_FILE,
        JSON.stringify(
          {
            email: next.email,
            displayName: next.displayName,
            plan: next.plan,
            creditBalance: next.creditBalance,
          },
          null,
          2,
        ),
      )
    } catch {}
    return { ok: true, account: next }
  })

  registerHandle('home:account-login', async (_event: unknown, _args: unknown) => {
    const acc = loadWebAccount()
    return { ok: true, email: acc.email, displayName: acc.displayName }
  })

  registerHandle('home:account-login-open-url', () => ({
    url: 'https://account.genspark.ai/login',
  }))

  registerHandle('home:account-logout', () => ({ ok: true }), { scope: 'soft:auth:write' })

  /* Real GitHub star count for the About pane. Returns null (not a
   * placeholder number) when the API is unreachable, so the UI stays honest. */
  let cachedGithubStars: number | null = null
  registerHandle('home:github-stars', async () => {
    if (cachedGithubStars !== null) return cachedGithubStars
    try {
      const response = await fetch('https://api.github.com/repos/louloulin/genoffice', {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return null
      const body: unknown = await response.json()
      const count = (body as { stargazers_count?: unknown }).stargazers_count
      if (typeof count !== 'number' || !Number.isFinite(count)) return null
      cachedGithubStars = count
      return count
    } catch {
      return null
    }
  })

  registerHandle('home:get-analytics-enabled', () => true)
  registerHandle('home:set-analytics-enabled', (_event: unknown, enabled: unknown) => ({
    ok: true,
    enabled,
  }), { scope: 'soft:preferences:write' })

  registerHandle('home:get-default-save-dir', () => DATA_DIR)
  registerHandle('home:pick-default-save-dir', () => DATA_DIR)

  registerHandle('home:get-update-channel', () => 'stable')
  registerHandle('home:set-update-channel', (_event: unknown, channel: unknown) => ({
    ok: true,
    channel,
  }), { scope: 'soft:admin' })

  /* ── Onboarding flag ─────────────────────────────────────────────
   * The web build has no real login / first-run backend, but the renderer
   * still wants to know whether to show the welcome overlay. Track the flag
   * in a small JSON file so onboarding shows once per fresh install and
   * stays dismissed thereafter. */
  const ONBOARDING_FILE = join(DATA_DIR, 'onboarding.json')
  function loadOnboarding(): boolean {
    try {
      if (existsSync(ONBOARDING_FILE)) {
        const raw = JSON.parse(readFileSync(ONBOARDING_FILE, 'utf-8'))
        return Boolean(raw?.seen)
      }
    } catch {}
    return false
  }
  registerHandle('home:onboarding-seen', () => loadOnboarding())
  registerHandle('home:set-onboarding-seen', (_event: unknown, seen: unknown) => {
    /* Renderer can call this with no args (the common "I'm done with
     * onboarding" path) or with an explicit boolean. Default to marking
     * the onboarding seen when called without arguments so the welcome
     * overlay stays dismissed after the user clicks skip / next. */
    const value = seen === undefined ? true : Boolean(seen)
    try {
      writeFileSync(ONBOARDING_FILE, JSON.stringify({ seen: value, setAt: Date.now() }, null, 2))
    } catch {}
    return value
  }, { scope: 'soft:preferences:write' })

  registerHandle('home:star-prompt-should-show', () => ({ shouldShow: false }))
  registerHandle('home:star-prompt-action', (_event: unknown, action: unknown) => {
    return { ok: true, action }
  })

  /* ── Cloud projects ────────────────────────────────────────────────────
   * The Electron build syncs the signed-in user's Genspark projects through
   * the bundled `gsk` CLI. The standalone web server has no account session,
   * so it reports `available: false` — the home pane then renders its
   * sign-in / empty state instead of fabricated project rows. */
  const buildCloudSnapshot = () => ({
    available: false,
    projects: [],
    syncedAt: 0,
  })
  registerHandle('home:cloud-projects', () => buildCloudSnapshot())
  registerHandle('home:cloud-projects-cached', () => buildCloudSnapshot())

  registerHandle('home:open-cloud-project', (_event: unknown, projectUrl: unknown) => {
    return { ok: true, url: projectUrl }
  })

  registerHandle('home:open-gen-team', () => ({ ok: true }))
  registerHandle('home:open-credit-usage', () => ({ ok: true }))
  registerHandle('home:open-github-repo', () => ({ ok: true }))

  registerHandle('home:stat-paths', async (_event: unknown, paths: unknown) => {
    /* Probing an arbitrary path would disclose whether a host file exists
     * and how big it is; an unmanaged path reports the same shape as a
     * missing one. `storage://<backend>/<key>` URIs go through the
     * active backend so MinIO/S3/rustfs files surface with the same
     * shape the local filesystem would. */
    const list = Array.isArray(paths) ? paths : []
    const out: Array<{ path: unknown; exists: boolean; size: number }> = []
    for (const p of list) {
      if (typeof p !== 'string') {
        out.push({ path: p, exists: false, size: 0 })
        continue
      }
      if (storageKeyFromPath(p)) {
        /* Backend-stored URI: head() the key. */
        try {
          const head = await getStorageBackend().head(storageKeyFromPath(p)!)
          out.push({ path: p, exists: head.exists, size: Number(head.size) })
        } catch {
          out.push({ path: p, exists: false, size: 0 })
        }
        continue
      }
      if (isManagedPath(p)) {
        try {
          if (existsSync(p)) {
            out.push({ path: p, exists: true, size: statSync(p).size })
            continue
          }
        } catch {
          /* fall through */
        }
      }
      out.push({ path: p, exists: false, size: 0 })
    }
    return out
  })

  registerHandle('home:browse', () => ({ canceled: false, filePaths: [] }))
}
