/**
 * Home (start page) channels — recents, starred, theme/language, account
 * status, analytics, update-channel, onboarding, github stars, stat paths,
 * browse, new-{doc/sheet/slide/markdown/pdf}, delete/rename/duplicate, reveal,
 * open-trash, cloud-projects. The recents and starred sets share the maps
 * declared in `common/state.ts` (`DOCS_RECENT`, `DOCS_STARRED`).
 */
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
/** Map a DocInfo record to the RecentEntry shape the home renderer expects,
 *  stat-ing the file for size/mtime. Files that fail to stat are flagged
 *  `missing` instead of being dropped (mirrors the desktop behaviour). */
function toRecentEntry(d: {
  id: string
  path: string
  name: string
  openedAt?: number
  modified?: boolean
}): {
  path: string
  name: string
  ext: string
  mtimeMs: number
  sizeBytes: number
  starred: boolean
  missing?: boolean
} {
  const ext =
    d.path
      .split(/[\\./]/)
      .pop()
      ?.toLowerCase() ?? ''
  try {
    if (existsSync(d.path)) {
      const s = statSync(d.path)
      return {
        path: d.path,
        name: d.name,
        ext,
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
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
  saveRecentDocs,
  saveStarredDocs,
} from '../common/index'

/* ── Blank file templates ────────────────────────────────────────────
 * A new docx/xlsx/pptx must round-trip through the matching renderer before
 * the user types anything, and each renderer validates the zip magic +
 * Content_Types on open. An empty file or a fresh `home:new-*` path that
 * never existed on disk used to land the renderer on a parse error
 * (markdown) or an empty grid (sheets), neither of which matched the
 * recents entry the renderer was just handed. Writing a known-good
 * minimal zip from an embedded template makes the recents entry
 * accurate and the first paint a real empty document. */
const BLANK_TEMPLATES: Readonly<Record<'docx' | 'xlsx' | 'pptx', string>> = {
  docx: 'UEsDBBQAAAAIAPi8M13XeYTq8QAAALgBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE730Ky9cqccoBIZSkB36OwKE8wMreJFb9J69b2rdn00KREOVozXwz62nXB+/EHjPZGDq5qhspMOhobBg7+b55ru6koALBgIsBO3lEkut+0W6OCUkwHKiTUynpXinSE3qgOiYMrAwxeyj8zKNKoLcworppmlulYygYSlXmDNkvhGgfcYCdK+LpwMr5loyOpHg4e+e6TkJKzmoorKt9ML+Kqq+SmsmThyabaMkGqa6VzOL1jh/0lSfK1qB4g1xewLNRfcRslIl65xmu/0/649o4DFbjhZ/TUo4aiXh77+qL4sGG71+06jR8/wlQSwMEFAAAAAgA+LwzXSAbhuqyAAAALgEAAAsAAABfcmVscy8ucmVsc43Puw6CMBQG4J2naM4uBQdjDIXFmLAafICmPZRGeklbL7y9HRzEODie23fyN93TzOSOIWpnGdRlBQStcFJbxeAynDZ7IDFxK/nsLDJYMELXFs0ZZ57yTZy0jyQjNjKYUvIHSqOY0PBYOo82T0YXDE+5DIp6Lq5cId1W1Y6GTwPagpAVS3rJIPSyBjIsHv/h3ThqgUcnbgZt+vHlayPLPChMDB4uSCrf7TKzQHNKuorZvgBQSwMEFAAAAAgA+LwzXd5vwPaNAAAArwAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWNQQ7CIBBF956CzN5OdWFMU+jOE+gBELBtUmYIg9beXlwYVz8vP3mvH95xUa+QZWbScGhaUIEc+5lGDbfrZX8GJcWStwtT0LAFgcHs+rXz7J4xUFHVQNKtGqZSUocobgrRSsMpUP0enKMtFfOIK2efMrsgUgNxwWPbnjDamcBU5Z399t2Epscf4j9lPlBLAQIUAxQAAAAIAPi8M13XeYTq8QAAALgBAAATAAAAAAAAAAAAAACAAQAAAABbQ29udGVudF9UeXBlc10ueG1sUEsBAhQDFAAAAAgA+LwzXSAbhuqyAAAALgEAAAsAAAAAAAAAAAAAAIABIgEAAF9yZWxzLy5yZWxzUEsBAhQDFAAAAAgA+LwzXd5vwPaNAAAArwAAABEAAAAAAAAAAAAAAIAB/QEAAHdvcmQvZG9jdW1lbnQueG1sUEsFBgAAAAADAAMAuQAAALkCAAAAAA==',
  xlsx: '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',
  pptx: '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',
}
function readBlankTemplate(ext: 'docx' | 'xlsx' | 'pptx'): Buffer | null {
  const b64 = BLANK_TEMPLATES[ext]
  if (!b64) return null
  try {
    return Buffer.from(b64, 'base64')
  } catch {
    return null
  }
}

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
  registerHandle('home:get-app-version', () => '1.0.0')

  /* Expose the resolved data / file roots so the web renderer can predict
   * the exact path of a freshly-created blank file in a single synchronous
   * window.open(url) call. Without this, the quick-start cards have to
   * open an about:blank tab and navigate it after awaiting IPC, which
   * browsers silently drop because the navigate happens outside the user
   * gesture stack and after the popup grant window has already closed. */
  registerHandle('home:get-data-paths', () => ({ dataDir: DATA_DIR, filesDir: FILES_DIR }))

  registerHandle('home:get-theme', () => 'light')
  registerHandle('home:set-theme', (_event: unknown, theme: unknown) => ({ ok: true, theme }))

  registerHandle('home:get-language', () => 'zh-CN')
  registerHandle('home:set-language', (_event: unknown, lang: unknown) => ({
    ok: true,
    language: lang,
  }))

  registerHandle('home:recents', (_event: unknown, args: unknown) => {
    const {
      offset = 0,
      limit = 50,
      ext,
    } = (args || {}) as { offset?: number; limit?: number; ext?: string }
    const all = [...DOCS_RECENT.values()]
    const filtered = ext ? all.filter((d) => d.path.toLowerCase().endsWith('.' + ext)) : all
    const sliced = filtered.slice(offset, offset + limit)
    const entries = sliced.map((d) => toRecentEntry(d))
    return {
      entries,
      total: filtered.length,
      totalAll: all.length,
    }
  })

  registerHandle('home:starred', (_event: unknown, args: unknown) => {
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
    const entries = sliced.map((d) => toRecentEntry(d))
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
  })

  registerHandle('home:delete-files', async (_event: unknown, paths: unknown) => {
    const values = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    const refused: string[] = []
    let deleted = 0
    values.forEach((path) => {
      // Refuse anything outside managed storage before touching the disk; this
      // loop used to unlink any path handed to it. Out-of-storage paths are
      // reported back instead of being silently skipped.
      if (!isManagedPath(path)) {
        refused.push(path)
        return
      }
      if (existsSync(path)) {
        unlinkSync(path)
        deleted += 1
      }
    })
    // `deleted` is the count that actually happened, not the count requested.
    return refused.length > 0 ? { ok: refused.length < values.length, deleted, refused } : { ok: true, deleted }
  })

  registerHandle('home:duplicate-file', async (_event: unknown, path: unknown) => {
    if (typeof path !== 'string' || !isManagedPath(path)) return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (!existsSync(path)) return { ok: false, error: 'File not found' }
    const dir = dirname(path)
    const ext = extname(path)
    const base = basename(path, ext)
    const newPath = join(dir, `${base}-copy${ext}`)
    writeFileSync(newPath, readFileSync(path))
    return { ok: true, path: newPath }
  })

  registerHandle('home:rename-file', async (_event: unknown, path: unknown, newName: unknown) => {
    if (typeof path !== 'string' || !isManagedPath(path))
      return { ok: false, error: PATH_OUTSIDE_STORAGE }
    if (typeof newName !== 'string' || newName.length === 0 || newName === '.' || newName === '..' || basename(newName) !== newName) {
      // A bare file name only: a separator or `..` in `newName` would move the
      // file out of its directory, and out of managed storage.
      return { ok: false, error: 'invalid file name' }
    }
    if (!existsSync(path)) return { ok: false, error: 'File not found' }
    const newPath = join(dirname(path), newName)
    if (!isManagedPath(newPath)) return { ok: false, error: PATH_OUTSIDE_STORAGE }
    renameSync(path, newPath)
    return { ok: true, path: newPath }
  })

  registerHandle('home:reveal-path', (_event: unknown, path: unknown) => {
    return { ok: true, path }
  })

  registerHandle('home:open-trash', () => ({ ok: true }))

  registerHandle('home:new-doc', (_event: unknown, args: unknown) => {
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
    } catch { /* read-only storage: keep the recents entry anyway */ }
    DOCS_RECENT.set(path, { id, path, name: `${id}.docx`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
    return { id, path }
  })

  registerHandle('home:new-sheet', (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'sheet')
    const path = join(FILES_DIR, `${id}.xlsx`)
    /* Pre-write a known-good minimal xlsx so workbook:open-path's xlsx
     * sidecar parses it on the first try. The sheets app has no
     * NotFoundError fallback (the open failure surfaces as a status-bar
     * error), so the file has to be real from the start. */
    try {
      const tpl = readBlankTemplate('xlsx')
      if (tpl) writeFileSync(path, tpl)
    } catch { /* read-only storage: keep the recents entry anyway */ }
    DOCS_RECENT.set(path, { id, path, name: `${id}.xlsx`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
    return { id, path }
  })

  registerHandle('home:new-slide', (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'slide')
    const path = join(FILES_DIR, `${id}.pptx`)
    /* Pre-write a known-good minimal pptx so the slides renderer boots
     * onto a real empty deck (consistent with new-pdf / new-html). */
    try {
      const tpl = readBlankTemplate('pptx')
      if (tpl) writeFileSync(path, tpl)
    } catch { /* read-only storage: keep the recents entry anyway */ }
    DOCS_RECENT.set(path, { id, path, name: `${id}.pptx`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
    return { id, path }
  })

  registerHandle('home:new-markdown', (_event: unknown, args: unknown) => {
    const id = pickRendererId(args, 'md')
    const path = join(DATA_DIR, `${id}.md`)
    // Markdown is plain text, so an actual empty file on disk is safe to
    // open (parseDocText returns an empty envelope). Without this write,
    // the markdown app boots, calls markdown:read-file, hits a 404, and
    // shows "文件打开失败" — the user has to re-pick the file from recents.
    try { writeFileSync(path, '', 'utf-8') } catch { /* read-only storage: keep the recents entry anyway */ }
    DOCS_RECENT.set(path, { id, path, name: `${id}.md`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
    return { id, path }
  })

  registerHandle('home:new-pdf', (_event: unknown, args: unknown) => {
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
    DOCS_RECENT.set(path, { id, path, name: `${id}.pdf`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
    return { id, path }
  })

  registerHandle('home:new-html', (_event: unknown, args: unknown) => {
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
    DOCS_RECENT.set(path, { id, path, name: `${id}.html`, openedAt: Date.now(), modified: false })
    saveRecentDocs([...DOCS_RECENT.values()])
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

  registerHandle('home:account-logout', () => ({ ok: true }))

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
  }))

  registerHandle('home:get-default-save-dir', () => DATA_DIR)
  registerHandle('home:pick-default-save-dir', () => DATA_DIR)

  registerHandle('home:get-update-channel', () => 'stable')
  registerHandle('home:set-update-channel', (_event: unknown, channel: unknown) => ({
    ok: true,
    channel,
  }))

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
  })

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

  registerHandle('home:stat-paths', (_event: unknown, paths: unknown) => {
    // Probing an arbitrary path would disclose whether a host file exists and
    // how big it is; an unmanaged path reports the same shape as a missing one.
    return (Array.isArray(paths) ? paths : []).map((p) => ({
      path: p,
      exists: typeof p === 'string' && isManagedPath(p) && existsSync(p),
      size: typeof p === 'string' && isManagedPath(p) && existsSync(p) ? statSync(p).size : 0,
    }))
  })

  registerHandle('home:browse', () => ({ canceled: false, filePaths: [] }))
}
