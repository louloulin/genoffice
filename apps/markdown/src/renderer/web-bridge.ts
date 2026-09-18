/// Web-version bootstrap for the markdown renderer.
///
/// Loaded before main.tsx and only acts outside Electron: it installs the same
/// `window.markdownApi` / `window.projectApi` objects the preload exposes in
/// the desktop app, but backed by the HTTP/SSE transport against the running
/// Electron main process. Native-only channels (image picker, DOCX/PDF export)
/// get browser equivalents so the web version keeps the full feature surface.
/// Inside Electron the preload has already exposed the IPC-backed APIs and
/// this module leaves them untouched.
import { createHttpIpcTransport, isElectronRuntime } from '@genoffice/ipc-bridge/client'
import { downloadBytes, installBackToHome, pickFileBytes } from '@genoffice/ipc-bridge/web-native'
import { createMarkdownApi, createMarkdownProjectApi } from '../shared/markdown-api-factory'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the markdown renderer.
  installBackToHome({ label: '返回主页' })
  const transport = createHttpIpcTransport()
  // SAFETY: `window` has no `markdownApi` / `markdownFilesApi` /
  // `markdownProjectApi` in lib.dom. The bridge assigns those keys below
  // and reads them back through module-scoped helpers, so the cast is
  // sound within this renderer.
  const bridgedWindow = window as unknown as Record<string, unknown>
  // The current document path is read from `?open=` (query) or `#open=` (hash)
  // and updated by each successful save so a re-save lands back on the same
  // managed file. Both forms are accepted: the shell builds the URL with the
  // hash form (`#open=...`), while `?open=...` is used by direct navigation.
  function readCurrentPath(): string | null {
    const query = new URLSearchParams(window.location.search).get('open')
    if (query) return query
    const hash = new URLSearchParams(window.location.hash.slice(1)).get('open')
    return hash
  }
  let currentPath: string | null = readCurrentPath()
  bridgedWindow.markdownApi = createMarkdownApi(transport, {
    consumePending: async () => currentPath,
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => {},
    save: async (request) => {
      const result = (await transport.invoke('markdown:save', {
        ...request,
        path: currentPath,
      })) as { ok: true; path?: string } | { ok: false; error?: string; canceled?: true }
      if (result && 'path' in result && typeof result.path === 'string' && result.path) {
        currentPath = result.path
      }
      return result
    },
    pickImage: async () => {
      const picked = await pickFileBytes('image/png,image/jpeg,image/gif')
      if (!picked) return null
      const { name, bytes } = picked[0]
      const ext = name.split('.').pop()?.toLowerCase() ?? ''
      if (!['png', 'jpg', 'jpeg', 'gif'].includes(ext)) return null
      const base64 = bytesToBase64(bytes)
      return await transport.invoke('markdown:save-image', { base64, ext })
    },
    exportDocx: async (request) => {
      if (typeof request?.base64 !== 'string' || !request.base64) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      const safeName =
        String(request.suggestedName || 'Untitled').replace(/[/\\:*?"<>|]/g, '_') || 'Untitled'
      downloadBytes(`${safeName}.docx`, base64ToBytes(request.base64))
      return { ok: true, path: '' }
    },
    exportPdf: async (request) => {
      if (typeof request?.html !== 'string' || !request.html) {
        return { ok: false, error: 'markdown: bad export request' }
      }
      // SAFETY: window.open('', '_blank') opens an about:blank tab whose
      // origin is the caller's own. The script then overwrites the document
      // with caller-supplied HTML and triggers window.print(). Same-origin
      // write; not a redirect vector.
      const win = window.open('', '_blank')
      if (!win) return { ok: false, error: 'web: popup blocked' }
      win.document.open()
      win.document.write(request.html)
      win.document.close()
      win.addEventListener('load', () => win.print())
      return { ok: true, path: '' }
    },
  })
  bridgedWindow.projectApi = createMarkdownProjectApi(transport)
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

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}
