/// Browser-safe web equivalents for desktop-only channels.
///
/// The web version cannot show native dialogs, print via webContents, or touch
/// the OS clipboard/fonts directly. These helpers give the per-app web bridges
/// the same user-visible functionality with browser APIs:
///
///   • file open/pick  → `<input type="file">` + `web:write-temp-file` (bytes
///                       land in the main process, which then runs the normal
///                       open/add flow on the temp path);
///   • save/export     → main returns bytes, the browser downloads them;
///   • print           → `window.print()`;
///   • clipboard       → `navigator.clipboard`;
///   • font metrics    → canvas `measureText`;
///   • fullscreen      → `requestFullscreen`;
///   • tabs/windows    → `window.open`.
///
/// This module must stay free of node/electron imports (browser + preload-safe).

import type { IpcTransport } from './client'

/* The tab protocol lives in `./web-tabs` and is imported from there directly
 * (`@genoffice/ipc-bridge/web-tabs`), not re-exported here: this module is
 * pulled into every editor renderer, and routing through it would make the
 * browser bundle depend on the protocol by accident. */

/** Generic main-process web-file channels (registered by the bridge server). */
export const WEB_FILE_CHANNELS = {
  writeTempFile: 'web:write-temp-file',
  readFileBytes: 'web:read-file-bytes',
  makeTempDir: 'web:make-temp-dir',
} as const

export interface WebTempFile {
  name: string
  bytes: ArrayBuffer
}

export interface WebFileBridge {
  /** Write bytes to a main-process temp file; resolves with its path. */
  writeTempFile(name: string, bytes: ArrayBuffer): Promise<string>
  /** Read a main-process temp file back as bytes (for browser downloads). */
  readFileBytes(path: string): Promise<WebTempFile>
  /** Create a main-process temp directory; resolves with its path. */
  makeTempDir(): Promise<string>
}

export function createWebFileBridge(t: IpcTransport): WebFileBridge {
  return {
    async writeTempFile(name, bytes) {
      const result: unknown = await t.invoke(WEB_FILE_CHANNELS.writeTempFile, { name, bytes })
      if (typeof result !== 'string' || !result) {
        throw new Error('web: temp file write failed')
      }
      return result
    },
    async readFileBytes(path) {
      const result: unknown = await t.invoke(WEB_FILE_CHANNELS.readFileBytes, path)
      if (!result || typeof result !== 'object') {
        throw new Error('web: temp file read failed')
      }
      const record = result as { name?: unknown; bytes?: unknown }
      if (typeof record.name !== 'string' || !(record.bytes instanceof ArrayBuffer)) {
        throw new Error('web: temp file read returned an invalid shape')
      }
      return { name: record.name, bytes: record.bytes }
    },
    async makeTempDir() {
      const result: unknown = await t.invoke(WEB_FILE_CHANNELS.makeTempDir)
      if (typeof result !== 'string' || !result) {
        throw new Error('web: temp dir creation failed')
      }
      return result
    },
  }
}

/** Pick one or more files through a hidden `<input type="file">`. */
export function pickFileBytes(accept?: string, multiple = false): Promise<WebTempFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    document.body.appendChild(input)
    input.addEventListener(
      'change',
      () => {
        const files = input.files ? Array.from(input.files) : []
        input.remove()
        if (files.length === 0) {
          resolve(null)
          return
        }
        void Promise.all(
          files.map(
            (file) =>
              new Promise<WebTempFile>((done, fail) => {
                const reader = new FileReader()
                reader.onload = () => {
                  const result = reader.result
                  // SAFETY: `FileReader.readAsArrayBuffer` is documented to set
                  // `result` to an ArrayBuffer. The fallback branch exists for
                  // the readAsBinaryString/readAsDataURL paths in case the
                  // caller ever swaps the reader method; narrowing `result` to
                  // ArrayBuffer via `as unknown as` is the only way to recover
                  // the .buffer view across both ArrayBuffer and string-shaped
                  // return types. We then re-wrap defensively.
                  const bytes =
                    result instanceof ArrayBuffer
                      ? result
                      : new Uint8Array(result as unknown as ArrayBuffer).buffer
                  done({
                    name: file.name,
                    bytes,
                  })
                }
                reader.onerror = () => fail(reader.error ?? new Error('web: file read failed'))
                reader.readAsArrayBuffer(file)
              }),
          ),
        ).then(resolve, () => resolve(null))
      },
      { once: true },
    )
    input.click()
  })
}

/** Trigger a browser download of `bytes` under `name`. */
export function downloadBytes(name: string, bytes: ArrayBuffer): void {
  const blob = new Blob([bytes])
  const url = URL.createObjectURL(blob)
  triggerDownload(name, url)
  // Delay the revoke: Safari starts the download asynchronously and a URL
  // revoked in the same tick produces a 0-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Hand an already-created object URL (or any URL) to the browser as a
 * download. Split out from `downloadBytes` for the SDK's `downloadAs`,
 * which must RETURN the blob URL to the host so it can revoke it on its
 * own schedule rather than inside this helper's timer.
 *
 * Returns false when there is no DOM to click (SSR / a Web Worker), so
 * callers can report an honest failure instead of a silent no-op.
 */
export function triggerDownload(name: string, url: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  return true
}

/**
 * Create an object URL for `bytes` and return it without triggering the
 * download. The SDK's `downloadAs` uses this so the host owns the
 * lifecycle: it receives `blobUrl` in the command result and revokes it
 * when its own download UI is done.
 */
export function createDownloadUrl(bytes: ArrayBuffer, mime = 'application/octet-stream'): string {
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

/** Browser print dialog — the web equivalent of the desktop print pipeline. */
export function webPrint(): void {
  window.print()
}

/** Copy an image (data URL) to the clipboard via the async Clipboard API. */
export async function webCopyImage(dataUrl: string): Promise<boolean> {
  try {
    const response = await fetch(dataUrl)
    const blob = await response.blob()
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    return true
  } catch {
    return false
  }
}

/** Canvas-based font vertical metrics — the web equivalent of `docs:font-metrics`. */
export interface WebFontMetrics {
  ascent: number
  descent: number
  lineGap: number
  unitsPerEm: number
}

export function webFontMetrics(family: string): WebFontMetrics | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return null
  context.font = `64px "${family}"`
  const text = 'Hg'
  const width = context.measureText(text).width
  if (width <= 0) return null
  // 64px em box: ascent/descent approximated from the measured text extents.
  const metrics = context.measureText(text)
  const actualBoundingBoxAscent = metrics.actualBoundingBoxAscent ?? 0
  const actualBoundingBoxDescent = metrics.actualBoundingBoxDescent ?? 0
  const unitsPerEm = 1000
  const scale = unitsPerEm / 64
  return {
    ascent: Math.round(actualBoundingBoxAscent * scale),
    descent: Math.round(actualBoundingBoxDescent * scale),
    lineGap: 0,
    unitsPerEm,
  }
}

/** Browser fullscreen — the web equivalent of `slides:show-fullscreen`. */
export async function webFullscreen(): Promise<void> {
  await document.documentElement.requestFullscreen()
}

/**
 * Open a browser tab — the web equivalent of `win:new` / `tabs:*`.
 *
 * `url` is treated as untrusted: we only allow same-origin targets
 * (absolute URLs that share the current origin) or in-page hashes. Anything
 * else is dropped to avoid being an open-redirect / phishing primitive for
 * a renderer that gets its URL string from the webserver response.
 */
export function webOpenTab(url: string): void {
  if (typeof url !== 'string' || url.length === 0) return
  // Allow in-page anchors (#foo) unchanged — they're never a redirect.
  if (url.startsWith('#')) {
    // SAFETY: `#foo` is a same-document fragment; the browser will not
    // navigate away from the current page. No cross-origin surface.
    window.open(url, '_blank')
    return
  }
  try {
    const current = new URL(window.location.href)
    const target = new URL(url, current)
    if (target.origin === current.origin) {
      // SAFETY: we just compared `target.origin` to `current.origin` above;
      // a mismatch falls through to the no-op. Only same-origin URLs reach
      // this window.open call.
      window.open(target.toString(), '_blank')
      return
    }
  } catch {
    // Malformed URL — fall through and refuse to open.
  }
  // Refuse cross-origin / unparseable targets rather than silently redirecting.
}

/**
 * Persist `bytes` to the webserver's managed file area and (optionally)
 * attach it to a project. Returns `{ id, path, name }` so callers can
 * reuse the path with subsequent save-channel calls (e.g. `docs:save`,
 * `markdown:save`) — those handlers refuse to write outside DATA_DIR,
 * and the path `web:save-file` returns lives inside FILES_DIR.
 *
 * Channel: `web:save-file` (registered in apps/web-server/src/web/index.ts).
 */
export interface UploadedFile {
  id: string
  path: string
  name: string
}
export async function uploadFileToServer(
  t: IpcTransport,
  name: string,
  bytes: ArrayBuffer,
  projectId?: string,
): Promise<UploadedFile> {
  const result = (await t.invoke('web:save-file', { name, bytes, projectId })) as UploadedFile
  if (!result?.path) throw new Error('web:save-file returned no path')
  return result
}

/**
 * Mount a floating "返回主页" pill on the current page that navigates back to
 * the GenOffice shell (`?app=shell`). The web build has no native window
 * chrome, so each editor tab (docs/sheets/slides/pdf/markdown/html) ends up
 * feeling stranded — this gives the user a single visible way home from any
 * sub-page, including ones loaded via deep-link `/docs/...` or `/sheets/...`.
 *
 * The button is appended to <body>, uses the app's accent tokens, and
 * respects the persisted theme by reading the `data-theme` attribute set by
 * the UI tokens layer (no second source of truth).
 *
 * Safe to call more than once — it no-ops if the pill already exists.
 */
export function installBackToHome(options: { label?: string } = {}): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById('genoffice-back-to-home')
  if (existing) return

  const label = options.label || '返回主页'

  // Build the home URL defensively: a malformed `window.location` (rare, but
  // happens with broken history.replaceState calls from upstream pages) must
  // not crash the helper that mounts the back button.
  let homeHref = `/?app=shell`
  try {
    const here = new URL(window.location.href)
    // Drop any path segments beyond the first (e.g. /docs/foo → /?app=shell)
    const home = new URL(window.location.origin)
    home.searchParams.set('app', 'shell')
    // Carry the language preference across if the user picked one.
    const lang = here.searchParams.get('lang')
    if (lang) home.searchParams.set('lang', lang)
    homeHref = home.pathname + home.search
  } catch {
    // Fall back to a relative URL — the webserver always serves the shell
    // at `/?app=shell` regardless of how the request landed here.
  }

  const button = document.createElement('a')
  button.id = 'genoffice-back-to-home'
  button.href = homeHref
  button.textContent = label
  // Inline styles so we don't depend on a CSS file being loaded by every
  // app — the pill must work on raw HTML pages too.
  button.style.cssText = [
    'position:fixed',
    'top:12px',
    'right:12px',
    'z-index:2147483646',
    'display:inline-flex',
    'align-items:center',
    'gap:6px',
    'padding:6px 12px',
    'border-radius:999px',
    'background:var(--accent,#5b6cff)',
    'color:#fff',
    'font:500 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif',
    'text-decoration:none',
    'box-shadow:0 2px 8px rgba(0,0,0,.18)',
    'cursor:pointer',
    'opacity:.92',
    'transition:opacity .15s ease',
    'user-select:none',
  ].join(';')
  button.addEventListener('mouseenter', () => (button.style.opacity = '1'))
  button.addEventListener('mouseleave', () => (button.style.opacity = '.92'))

  // Defer until body exists (script type=module runs before DOMContentLoaded
  // on some browsers; index.html may also defer the body mount).
  const mount = () => document.body.appendChild(button)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
}
