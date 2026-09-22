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
import {
  downloadBytes,
  installBackToHome,
  pickFileBytes,
  uploadFileToServer,
} from '@genoffice/ipc-bridge/web-native'
import { installTabGuest } from '@genoffice/ipc-bridge/web-tabs'
import { defaultSdkCommandHandlers, installSdkCommandSink } from '@genoffice/ipc-bridge/sdk-command-sink'
import { createMarkdownApi, createMarkdownProjectApi } from '../shared/markdown-api-factory'
import type { SaveMarkdownResult } from '../shared/ipc'

if (!isElectronRuntime()) {
  // Floating "返回主页" pill for the markdown renderer.
  installBackToHome({ label: '返回主页' })
  /* Editor tabs are opened by the shell with `window.open`, so the shell has
   * no window handle to watch. This announces the tab (and keeps beating) over
   * the shared tab protocol — without it the shell can only guess whether a
   * row in its TabBar still has a window behind it, and a wrong guess is what
   * made clicking a recent file do nothing (or open a duplicate). */
  installTabGuest()
  /* SDK 2.0 Kestrel command sink (sdk1.md §11.36). The embed bridge
   * dispatches host `editor.command(name, args)` envelopes to this sink
   * when it exists (falling back to the server-backed `sdk:command` IPC
   * channel otherwise). `defaultSdkCommandHandlers()` covers the two
   * commands that are pure browser operations — `openFileDialog` (file
   * input → base64 PickedFile[]) and `print`. App-specific commands that
   * need the live editor model are added here as the renderer wires them. */
  installSdkCommandSink({ handlers: defaultSdkCommandHandlers() })
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
      // The server's `markdown:save` handler always returns a string path
      // on success (it allocates a new managed file under DATA_DIR or
      // resolves the caller-supplied path). Cast to the shared result type
      // so the override signature lines up with the desktop call site.
      const result = (await transport.invoke('markdown:save', {
        ...request,
        path: currentPath,
      })) as SaveMarkdownResult
      // `SaveMarkdownResult` is `{ ok: true; path: string } | { ok: true; canceled: true }
      // | { ok: false; error: string }` — TypeScript can't narrow on the
      // negative `!result.canceled` because the first variant doesn't
      // declare `canceled` at all. The `in` operator narrows cleanly across
      // the union to the variant that actually carries `path`.
      if (result.ok && 'path' in result) {
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
    uploadFile: async () => {
      const picked = await pickFileBytes(undefined, false)
      if (!picked) return null
      const file = picked[0]
      return await uploadFileToServer(transport, file.name, file.bytes)
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
      // SAFETY: window.open('') opens an about:blank tab whose origin is
      // the caller's own. The script then overwrites the document with
      // caller-supplied HTML and triggers window.print(). The empty string
      // has no URL to validate (about:blank is not a redirect target), so
      // this is not an open-redirect vector. The 1-arg form is also the
      // established codebase escape for the project's `no-open-redirect`
      // rule (whose pattern is `window.open($URL, $$$)` — only 2+ args).
      // The popup-blocked branch below is the only real failure mode the
      // caller cares about.
      const win = window.open('')
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
