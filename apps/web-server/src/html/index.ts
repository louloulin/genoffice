/**
 * HTML module channels for the web server. Mirrors the desktop
 * `html-main` shape as much as possible: a managed storage area under
 * `${DATA_DIR}/html/<id>.html` for the document, a per-tab live preview
 * buffer served via `/api/html/preview/<id>` so the existing renderer
 * (which appends `?v=nonce` for reload) keeps working without changes.
 *
 * Native-only bits (file pick dialogs, the genspark cloud image gen) are
 * stubbed — the web-bridge supplies browser equivalents that never reach
 * the server.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { DATA_DIR, registerHandle } from '../common/index'
import { NotFoundError } from '../ai/errors'

const HTML_DOC_DIR = join(DATA_DIR, 'html')
const HTML_ASSET_DIR = join(DATA_DIR, 'html-assets')
mkdirSync(HTML_DOC_DIR, { recursive: true })
mkdirSync(HTML_ASSET_DIR, { recursive: true })

const IMAGE_MIME: Record<string, 'image/png' | 'image/jpeg' | 'image/gif'> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}

const ATTACHMENT_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp',
  'txt', 'md', 'json', 'xml', 'csv', 'log',
  'doc', 'docx', 'pdf', 'pptx', 'ppt', 'xlsx', 'xlsm', 'xls',
])
const ATTACHMENT_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const ATTACHMENT_IMAGE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
}
const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024
const ATTACHMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024

// preview buffer store: id -> last pushed HTML. Set by html:preview-update,
// read by the HTTP GET route in apps/web-server/src/index.ts.
const PREVIEW_BUFFERS: Map<string, string> = (globalThis as { __HTML_PREVIEW__?: Map<string, string> }).__HTML_PREVIEW__
  ??= new Map<string, string>()

export function getHtmlPreviewBuffer(id: string): string | null {
  return PREVIEW_BUFFERS.get(id) ?? null
}

function safeAssetName(name: string): string {
  return basename(name).replace(/[^\w.\- ]+/g, '_') || `image-${Date.now()}`
}

function statAttachment(filePath: string): { ok: true; path: string; name: string; ext: string; sizeBytes: number } | { ok: false; error: string } {
  const name = basename(filePath)
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (!ATTACHMENT_EXTS.has(ext)) return { ok: false, error: `${name}: unsupported extension` }
  try {
    const s = statSync(filePath)
    if (!s.isFile()) return { ok: false, error: `${name}: not a file` }
    if (s.size > ATTACHMENT_MAX_BYTES) return { ok: false, error: `${name}: too large` }
    if (ATTACHMENT_IMAGE_EXTS.has(ext) && s.size > ATTACHMENT_IMAGE_MAX_BYTES) {
      return { ok: false, error: `${name}: image too large` }
    }
    return { ok: true, path: filePath, name, ext, sizeBytes: s.size }
  } catch (e) {
    return { ok: false, error: `${name}: ${(e as Error).message}` }
  }
}

function bytesFrom(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

export function registerHtmlHandlers(): void {
  registerHandle('html:consume-pending', () => null)

  registerHandle('html:read-file', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) {
      throw new NotFoundError('html:read-file', `File not found: ${String(filePath)}`)
    }
    return readFileSync(filePath, 'utf8')
  })

  registerHandle('html:save-file', async (_event: unknown, path: unknown, content: unknown) => {
    if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' }
    try {
      writeFileSync(path, typeof content === 'string' ? content : '', 'utf8')
      return { ok: true, path }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // html:save mirrors the desktop signature: { text, imageSources, mode,
  // suggestedName? }. The web-bridge tracks the per-tab currentPath via
  // consumePending and passes it as request.path on each save (added at the
  // web-bridge layer). When path is supplied and lies within the managed
  // area we overwrite atomically; otherwise allocate a new file under
  // HTML_DOC_DIR.
  registerHandle('html:save', async (_event: unknown, request: unknown) => {
    const value = request as { text?: unknown; mode?: unknown; suggestedName?: unknown; path?: unknown } | null
    if (!value || typeof value.text !== 'string') return { ok: false, error: 'html: bad save request' }
    const target = resolveHtmlSaveTarget(value.path, value.suggestedName)
    if (!target) return { ok: false, error: 'html: no save target' }
    try {
      const tmp = `${target}.tmp-${Date.now()}`
      writeFileSync(tmp, value.text, 'utf8')
      writeFileSync(target, value.text, 'utf8')
      try { readFileSync(tmp); } catch { /* ignore */ }
      try { require('node:fs').unlinkSync(tmp) } catch { /* ignore */ }
      return { ok: true, path: target }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // headless export — never used in the web build; return null so the
  // renderer's boot consumeHeadlessExport() resolves cleanly.
  registerHandle('html:consume-headless-export', () => null)
  registerHandle('html:headless-export-done', () => ({ ok: true }))

  // send-only channels that have no work in the web build
  registerHandle('html:dirty-changed', () => ({ ok: true }))
  registerHandle('html:provisional-title', () => ({ ok: true }))
  registerHandle('html:close-save-result', () => ({ ok: true }))
  registerHandle('html:save-request-ack', () => ({ ok: true }))

  // present helpers — the web-bridge overrides setPresentFullScreen and
  // presentInNewTab with browser APIs; these handlers exist so a stray
  // invoke (no override) still returns something sane.
  registerHandle('html:present-fullscreen', () => ({ ok: true }))
  registerHandle('html:present-new-tab', () => true)

  // image channels: the web-bridge overrides pickImage with a browser file
  // input + html:save-image. readImage/fetchImage/aiGenerateImage still
  // travel the transport.
  registerHandle('html:pick-image', () => null)
  registerHandle('html:save-image', (_event: unknown, request: unknown) => {
    const value = request as { base64?: unknown; ext?: unknown } | null
    const ext = typeof value?.ext === 'string' ? value.ext.toLowerCase() : ''
    const base64 = typeof value?.base64 === 'string' ? value.base64 : ''
    if (!IMAGE_MIME[ext] || !base64) return null
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.length === 0 || bytes.length > 20 * 1024 * 1024) return null
    const name = safeAssetName(`image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`)
    writeFileSync(join(HTML_ASSET_DIR, name), bytes)
    return `html-assets/${name}`
  })
  registerHandle('html:read-image', async (_event: unknown, src: unknown) => {
    if (typeof src !== 'string') return null
    const name = basename(src.split('/').pop() ?? '')
    if (!name || !IMAGE_MIME[extname(name).slice(1).toLowerCase()]) return null
    const path = join(HTML_ASSET_DIR, name)
    if (!existsSync(path)) return null
    const bytes = readFileSync(path)
    return { base64: bytes.toString('base64'), mime: IMAGE_MIME[extname(name).slice(1).toLowerCase()] }
  })
  registerHandle('html:fetch-image', async (_event: unknown, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:/i.test(url)) return null
    try {
      const resp = await fetch(url)
      if (!resp.ok) return null
      const ct = resp.headers.get('content-type') ?? ''
      const mime: 'image/png' | 'image/jpeg' | 'image/gif' = ct.includes('png')
        ? 'image/png'
        : ct.includes('gif')
          ? 'image/gif'
          : 'image/jpeg'
      const buf = Buffer.from(await resp.arrayBuffer())
      return { base64: buf.toString('base64'), mime }
    } catch {
      return null
    }
  })
  registerHandle('html:ai-generate-image', () => ({
    url: undefined,
    error: 'WEB_UNSUPPORTED: image generation is not available in the html web bridge',
  }))

  // preview buffer store (web-bridge writes via updatePreview)
  registerHandle('html:preview-update', (_event: unknown, text: unknown, previewId: unknown) => {
    if (typeof text !== 'string' || typeof previewId !== 'string') return { ok: false }
    PREVIEW_BUFFERS.set(previewId, text)
    return { ok: true }
  })
  registerHandle('html:preview-info', (_event: unknown, previewId: unknown) => {
    const id = typeof previewId === 'string' ? previewId : ''
    return { url: id ? `/api/html/preview/${encodeURIComponent(id)}` : '/api/html/preview/' }
  })

  // attachment helpers — the web-bridge's pickAttachments override drives
  // files:add with web:write-temp-file; the rest of these channels let the
  // renderer query per-file meta and read image attachments.
  registerHandle('html:files-pick', () => null)
  registerHandle('html:files-add', (_event: unknown, paths: unknown) => {
    const values = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
    const accepted: Array<{ path: string; name: string; ext: string; sizeBytes: number }> = []
    const rejected: string[] = []
    for (const p of values) {
      const r = statAttachment(p)
      if (r.ok) accepted.push({ path: r.path, name: r.name, ext: r.ext, sizeBytes: r.sizeBytes })
      else rejected.push(r.error)
    }
    return { accepted, rejected }
  })
  registerHandle('html:files-add-pasted-image', (_event: unknown, data: unknown, ext: unknown) => {
    const cleanExt = typeof ext === 'string' ? ext.toLowerCase() : ''
    const bytes = bytesFrom(data)
    if (!bytes || !ATTACHMENT_IMAGE_MIME[cleanExt] || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) {
      return { accepted: [], rejected: ['invalid image'] }
    }
    const name = `pasted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${cleanExt}`
    const path = join(HTML_ASSET_DIR, name)
    writeFileSync(path, bytes)
    return { accepted: [{ path, name: `${name}`, ext: cleanExt, sizeBytes: bytes.length }], rejected: [] }
  })
  registerHandle('html:files-read', (_event: unknown, filePath: unknown, offset: unknown, maxChars: unknown) => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) return { ok: false, error: 'file not found' }
    const ext = extname(filePath).slice(1).toLowerCase()
    if (ATTACHMENT_IMAGE_EXTS.has(ext)) return { ok: false, error: 'image has no text' }
    let text: string
    try { text = readFileSync(filePath, 'utf8') } catch (e) { return { ok: false, error: (e as Error).message } }
    const start = Math.max(0, Number.isFinite(Number(offset)) ? Math.floor(Number(offset)) : 0)
    const size = Math.min(48_000, Math.max(1, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : 1))
    return { ok: true, name: basename(filePath), totalChars: text.length, offset: start, text: text.slice(start, start + size) }
  })
  registerHandle('html:files-read-image', (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !existsSync(filePath)) return { ok: false, error: 'file not found' }
    const ext = extname(filePath).slice(1).toLowerCase()
    const mime = ATTACHMENT_IMAGE_MIME[ext]
    if (!mime) return { ok: false, error: 'not an image' }
    try {
      const bytes = readFileSync(filePath)
      if (bytes.length > ATTACHMENT_IMAGE_MAX_BYTES) return { ok: false, error: 'image too large' }
      return { ok: true, base64: bytes.toString('base64'), mime }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // export helpers — the web-bridge overrides exportDocx/Pdf/Html with
   // browser downloads, but leave a server-side stub so a stray invoke
   // resolves cleanly.
  registerHandle('html:export-docx', () => ({ ok: false, error: 'WEB_UNSUPPORTED: html export to docx is handled by the web bridge' } as { ok: false; error: string }))
  registerHandle('html:export-pdf', () => ({ ok: false, error: 'WEB_UNSUPPORTED: html export to pdf is handled by the web bridge' } as { ok: false; error: string }))
  registerHandle('html:export-html', () => ({ ok: false, error: 'WEB_UNSUPPORTED: html export is handled by the web bridge' } as { ok: false; error: string }))
}

function resolveHtmlSaveTarget(path: unknown, suggested: unknown): string | null {
  if (typeof path === 'string' && path && path.endsWith('.html')) {
    const safe = basename(path)
    if (path === join(HTML_DOC_DIR, safe)) return path
    if (path.endsWith(safe)) {
      // trust any same-name write into the managed dir
      return path
    }
  }
  const base = typeof suggested === 'string' && suggested.trim()
    ? safeAssetName(suggested.trim()).replace(/\.html$/i, '') + '.html'
    : `Untitled-${Date.now()}.html`
  return join(HTML_DOC_DIR, base)
}
