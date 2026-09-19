/// Web-version bootstrap for the html renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.htmlApi` / `window.projectApi` objects the preload exposes in the
/// desktop app, but backed by the HTTP/SSE transport. Native-only channels
/// (open/save dialogs, native dialogs, OS file paths, fullscreen, print)
/// get browser equivalents so the web version keeps the full feature
/// surface. Inside Electron the preload has already exposed the IPC-backed
/// APIs and this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import {
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
  webFullscreen,
} from '@genoffice/ipc-bridge/web-native'
import { createHtmlApi, createHtmlProjectApi } from '../shared/html-api-factory'
import type { ExportDocxRequest, ExportPdfRequest, ExportHtmlRequest } from '../shared/ipc'

/**
 * Open a validated same-origin URL in a new tab.
 *
 * Returns null when the URL is not same-origin (so a caller-supplied string can
 * never become a redirect to a third-party domain) or when the popup was
 * blocked. The origin comparison below is what makes this safe; the call uses
 * the single-argument `window.open` form, which defaults to a new tab because
 * the app's top-level `window.name` is empty.
 */
function openSameOriginTab(url: string): Window | null {
  const target = new URL(url, window.location.href)
  if (target.origin !== window.location.origin) return null
  return window.open(target.toString())
}

/**
 * Open a fresh `about:blank` tab for a document.write + print flow.
 *
 * The single empty-string argument keeps the new context on `about:blank`, so
 * markup the caller writes into it is same-origin with the opener.
 */
function openBlankTab(): Window | null {
  return window.open('')
}

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the html renderer.
  installBackToHome({ label: '返回主页' })
  const transport = createHttpIpcTransport()
  // SAFETY: `window` has no `htmlApi` / `htmlFilesApi` / `htmlProjectApi`
  // in lib.dom. The bridge assigns those keys below and reads them back
  // through module-scoped helpers, so the cast is sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>

  // a per-tab id for the live preview: the owner writes the buffer to
  // `html:preview-update` and the preview iframe loads it via
  // `/api/html/preview/<id>`. A present tab opens that URL directly.
  const previewId = crypto.randomUUID
    ? crypto.randomUUID()
    : `p-${Math.random().toString(36).slice(2)}`
  const previewUrlBase = `${location.origin}/api/html/preview/${previewId}`

  bridgedWindow.htmlApi = createHtmlApi(transport, {
    consumePending: async () => {
      const hash = new URLSearchParams(window.location.hash.slice(1)).get('open')
      const query = new URLSearchParams(window.location.search).get('open')
      const open = hash ?? query
      if (!open) return null
      // grant the path to the bridge sender so html:read-file accepts it
      return open
    },
    updatePreview: (text) => {
      transport.send('html:preview-update', text, previewId)
    },
    getPreviewInfo: async () => ({ url: previewUrlBase }),
    setPresentFullScreen: async (on) => {
      if (on) {
        try {
          await webFullscreen()
        } catch {
          /* user denied */
        }
      } else if (document.fullscreenElement) {
        try {
          await document.exitFullscreen()
        } catch {
          /* ignore */
        }
      }
    },
    presentInNewTab: async (title) => {
      // `previewUrlBase` is `${location.origin}/api/html/preview/${previewId}`
      // (id is a fresh `crypto.randomUUID()` per renderer load), and
      // openSameOriginTab re-checks the origin before opening.
      const tab = openSameOriginTab(previewUrlBase)
      if (tab && title) tab.document.title = title
      return Boolean(tab)
    },
    uploadFile: async () => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      return await uploadFileToServer(transport, file.name, file.bytes)
    },
    pickImage: async () => {
      const picked = await pickFileBytes('image/png,image/jpeg,image/gif')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      const base64 = bytesToBase64(bytes)
      const rel = await transport.invoke('html:save-image', { base64, ext })
      return typeof rel === 'string' ? rel : null
    },
    addPastedImage: async (data, ext) => {
      return await transport.invoke('files:add-pasted-image', data, ext)
    },
    pickAttachments: async () => {
      const picked = await pickFileBytes(undefined, true)
      if (!picked) return null
      const paths: string[] = []
      for (const file of picked) {
        const path = await transport.invoke('web:write-temp-file', {
          name: file.name,
          bytes: file.bytes,
        })
        if (typeof path === 'string') paths.push(path)
      }
      return await transport.invoke('files:add', paths)
    },
    exportDocx: async (request: ExportDocxRequest) => {
      downloadBytes(
        `${sanitize(request.suggestedName) || 'document'}.docx`,
        textToBytes(request.html),
      )
      return { ok: true, path: '' }
    },
    exportPdf: async (request: ExportPdfRequest) => {
      if (typeof request?.html !== 'string' || !request.html) {
        return { ok: false, error: 'html: bad export request' }
      }
      // `about:blank` keeps the written markup same-origin with this window.
      const win = openBlankTab()
      if (!win) return { ok: false, error: 'web: popup blocked' }
      win.document.open()
      win.document.write(request.html)
      win.document.close()
      win.addEventListener('load', () => win.print())
      return { ok: true, path: '' }
    },
    exportHtml: async (request: ExportHtmlRequest) => {
      downloadBytes(
        `${sanitize(request.suggestedName) || 'document'}.html`,
        textToBytes(request.html),
      )
      return { ok: true, path: '' }
    },
    getPathForFile: () => '',
  })
  bridgedWindow.projectApi = createHtmlProjectApi(transport)
}

function sanitize(name: string): string {
  return String(name || '').replace(/[/\\:*?"<>|]/g, '_')
}

function textToBytes(html: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(html)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function bytesToBase64(bytes: ArrayBuffer): string {
  let binary = ''
  const view = new Uint8Array(bytes)
  const CHUNK = 0x8000
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
