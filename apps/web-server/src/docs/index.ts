/**
 * Docs IPC channels — recent, font-metrics, pick-image, settings,
 * open/save/read/print. Persistence is in-memory + `docs-recent.json`; the
 * `DOCS_RECENT` map referenced by `home:recents` is the same singleton
 * declared in `common/state.ts`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  DATA_DIR,
  FILES_DIR,
  isManagedPath,
  loadProjects,
  loadRecentDocs,
  randomFileId,
  registerHandle,
  reserveDailyPasteQuota,
  sanitizeFileName,
  saveProjects,
  saveRecentDocs,
} from '../common/index'

const PASTE_QUOTA_FILE = join(DATA_DIR, '.quotas', 'paste.json')
import { assertMagicMatchesExtension } from '../common/magic'
import { atomicWriteFile } from '../common/atomic'
import { recordRecentDoc } from '../common/document-stores'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'

const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024
const closeState = {
  check: null as { dirty: boolean; autoSave: boolean; filePath: string | null } | null,
  saveOk: null as boolean | null,
}

function isManagedDocPath(filePath: string): boolean {
  return (
    /\.docx$/i.test(filePath) && isManagedPath(filePath)
  )
}

function bytesFrom(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return null
}

// Mirrors apps/docs/src/main/docx-encryption.ts:isEncryptedDocx for the web build.
// The renderer contract (OpenFileResult) distinguishes encrypted from plain
// docx so a CFB (OLE2) container signals "needs password" instead of being
// passed to the zip-based parser.
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')
function isCfb(bytes: Buffer): boolean {
  return bytes.length >= 8 && bytes.subarray(0, 8).equals(CFB_MAGIC)
}
function isEncryptedDocxBytes(bytes: Buffer): boolean {
  return isCfb(bytes) && bytes.includes(ENCRYPTED_STREAM_UTF16)
}
function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function registerDocsHandlers(): void {
  // The desktop main process types one trusted space and the renderer scrubs it
  // back out (see `apps/docs/src/main/docs-main.ts` docs:respell-kick). The web
  // renderer cannot deliver a trusted keystroke; a browser-driven input event
  // is *untrusted* and does not respell Blink anyway. Answering the channel
  // here turns the caller's swallowed 404 (`IPC_NO_HANDLER`) into an explicit
  // success so the renderer's idempotent kick just no-ops without logging an
  // error. Spellcheck will respell as soon as the user types — same final
  // state as the desktop path, just without the synthetic keystroke.
  registerHandle('docs:respell-kick', () => ({ ok: true, supported: false }))

  registerHandle('docs:view-menu-state', () => ({ ok: true }))

  registerHandle('docs:discard-password-intents', (_event: unknown, throughRevision: unknown) => ({
    ok:
      typeof throughRevision === 'number' &&
      Number.isSafeInteger(throughRevision) &&
      throughRevision >= 0,
  }))

  registerHandle('docs:recent', () => loadRecentDocs())

  registerHandle('docs:font-metrics', (_event: unknown, family: unknown) => ({
    family: family || 'sans-serif',
    ascent: 0.8,
    descent: 0.2,
    lineGap: 0.1,
    unitsPerEm: 1000,
  }))

  registerHandle('docs:pick-image', () => ({
    canceled: false,
    dataUrl: null,
    message: '请使用 Web File API 在前端选择图片',
  }))

  registerHandle('docs:get-settings', () => ({
    language: 'zh-CN',
    spellCheck: true,
    autoSave: true,
    autoSaveInterval: 30000,
    fontSize: 14,
    fontFamily: 'sans-serif',
  }))

  registerHandle('docs:save-settings', () => ({ ok: true }))

  registerHandle('docs:close-check-result', (_event: unknown, state: unknown) => {
    const value = state as { dirty?: unknown; autoSave?: unknown; filePath?: unknown } | null
    closeState.check = {
      dirty: value?.dirty === true,
      autoSave: value?.autoSave === true,
      filePath: typeof value?.filePath === 'string' ? value.filePath : null,
    }
  })

  registerHandle('docs:close-save-result', (_event: unknown, ok: unknown) => {
    closeState.saveOk = ok === true
  })

  registerHandle('docs:open', async (_event: unknown, options: unknown) => {
    const opts = options as { docx?: ArrayBuffer; path?: string } | undefined
    const id = `doc-${Date.now()}`

    if (opts?.docx) {
      const bytes = Buffer.from(opts.docx)
      assertMagicMatchesExtension('docs:open', '.docx', bytes)
      const name = `文档-${new Date().toLocaleDateString()}.docx`
      const path = join(FILES_DIR, `${id}.docx`)
      writeFileSync(path, bytes)

      const recent = loadRecentDocs()
      recent.unshift({ id, path, name, openedAt: Date.now(), modified: false })
      saveRecentDocs(recent)

      return { id, path, name }
    }

    return { id, path: '', name: '新文档.docx' }
  })

  registerHandle('docs:open-path', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isManagedDocPath(filePath)) {
      throw new InvalidArgumentError('docs:open-path', 'path is outside the web storage area')
    }
    if (!existsSync(filePath as string)) {
      throw new NotFoundError('docs:open-path', `File not found: ${String(filePath)}`)
    }

    const original = readFileSync(filePath as string)
    const name = basename(filePath as string)
    const path = filePath as string

    // ECMA-376 encrypted docx (CFB / OLE2 + EncryptedPackage): the renderer
    // prompts for the password and retries via docs:open-decrypt, mirroring
    // the Electron main process's flow. The web build doesn't yet ship the
    // crypto dependency, so it surfaces needsPassword instead of pretending
    // the encrypted bytes parse cleanly.
    if (isEncryptedDocxBytes(original)) {
      return { needsPassword: true, path, name }
    }

    // Magic-mismatch gate before handing bytes to the real parser. The web
    // build has no Electron path-grant map, so the only signal that the
    // file extension is honest is the file's own magic bytes. Failing
    // here surfaces a structured `MagicMismatchError` to the renderer
    // instead of a cryptic "Can't find end of central directory" stack
    // trace from JSZip. The .docx case is the one the desktop build has
    // always cared about; the other extensions (`assertMagicMatchesExtension`
    // looks at `.docx`, `.xlsx`, `.pptx`, `.pdf`, images, plain text) get
    // the same treatment for free.
    assertMagicMatchesExtension('docs:open-path', path, original)

    const hash = createHash('sha256').update(original).digest('hex')
    const id = `doc-${Date.now()}`
    const recent = loadRecentDocs()
    recent.unshift({ id, path, name, openedAt: Date.now(), modified: false })
    saveRecentDocs(recent)

    // Shape matches OpenFileResult from apps/docs/src/shared/ipc.ts so the
    // renderer's loadFile (apps/docs/src/renderer/file-actions.ts) reads
    // result.data and result.hash directly. The previous `bytes` field name
    // caused the renderer to parse an empty Uint8Array and fail open with a
    // status-bar toast.
    return {
      path,
      name,
      data: toArrayBuffer(original),
      hash,
      encrypted: false,
    }
  })

  registerHandle('docs:read-path', async (_event: unknown, filePath: unknown) => {
    if (typeof filePath !== 'string' || !isManagedDocPath(filePath)) return null
    if (!existsSync(filePath as string)) {
      return null
    }
    const original = readFileSync(filePath as string)
    if (isEncryptedDocxBytes(original)) return null
    return {
      name: basename(filePath as string),
      data: toArrayBuffer(original),
      hash: createHash('sha256').update(original).digest('hex'),
      encrypted: false,
    }
  })

  registerHandle(
    'docs:save',
    async (_event: unknown, filePath: unknown, data: unknown, _auto?: unknown) => {
      if (typeof filePath !== 'string' || !isManagedDocPath(filePath)) {
        return { ok: false, error: 'save target is outside the web storage area' }
      }
      const bytes = bytesFrom(data)
      if (!bytes || bytes.byteLength === 0) {
        return { ok: false, error: 'save data is empty or invalid' }
      }
      try {
        // Atomic: a crash mid-write cannot leave the document half-written on
        // disk. Uses the shared kernel implementation so the Windows
        // EPERM-retry behaviour matches the desktop build exactly.
        atomicWriteFile(filePath, bytes)
        /* Dual write. The legacy mirror feeds the in-session home grid, and
         * `unifiedRecents` is what makes the entry survive a restart — without
         * it a saved document vanished from recents the next time the server
         * booted, which reads to the user as "my save was lost". */
        await recordRecentDoc(filePath, {
          id: basename(filePath, extname(filePath)),
          name: basename(filePath),
          modified: true,
        })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  registerHandle('docs:create-document', async (_event: unknown, request: unknown) => {
    const value = request as { type?: unknown; title?: unknown; content?: unknown } | null
    const type = value?.type
    const title = sanitizeFileName(value?.title ?? 'Untitled', 'Untitled').slice(0, 80) || 'Untitled'
    const content = typeof value?.content === 'string' ? value.content : ''
    if (!content.trim()) return { ok: false, error: 'content must not be empty' }
    if (type !== 'md' && type !== 'html') {
      return {
        ok: false,
        error: `WEB_UNSUPPORTED: document type '${String(type)}' requires the desktop renderer`,
      }
    }
    const filePath = join(DATA_DIR, `${title}.${type}`)
    try {
      // Atomic temp+rename so a crash cannot leave a partial document on
      // disk. Mirrors docs:save and web:save-file.
      const tmpPath = `${filePath}.${randomFileId('tmp').split('-')[0]}.tmp`
      writeFileSync(tmpPath, content, 'utf8')
      renameSync(tmpPath, filePath)
      return { ok: true, path: filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerHandle('docs:open-decrypt', () => ({
    ok: false,
    reason: 'error',
    error: 'WEB_UNSUPPORTED: password-protected DOCX requires the desktop renderer',
  }))

  registerHandle('docs:set-password', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: DOCX password protection requires the desktop renderer',
  }))

  registerHandle('docs:ai-generate-image', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: image generation is not available in the web docs bridge',
  }))

  registerHandle('files:add-pasted-image', async (_event: unknown, data: unknown, ext: unknown) => {
    const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(cleanExt)) {
      return { accepted: [], rejected: ['not an image'] }
    }
    const bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) return { accepted: [], rejected: ['image data is empty'] }
    if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) {
      return { accepted: [], rejected: ['image is too large'] }
    }
    // Magic-byte gate: a renderer that names a JPEG with a .png extension
    // used to slip through (or vice versa). Reject before reserving quota
    // so a misbehaving tab can't burn the day's allowance on rejected
    // bytes.
    assertMagicMatchesExtension('files:add-pasted-image', `.${cleanExt}`, bytes)
    try {
      reserveDailyPasteQuota(PASTE_QUOTA_FILE, bytes.byteLength)
    } catch (error) {
      return {
        accepted: [],
        rejected: [error instanceof Error ? error.message : 'quota exceeded'],
      }
    }
    const safeExt = sanitizeFileName(cleanExt, 'png')
    const name = `pasted-${randomFileId('paste').split('-')[0]}.${safeExt}`
    const path = join(FILES_DIR, name)
    // Atomic temp+rename: a crash mid-write cannot leave a half-image on
    // disk AND keep the day's quota counter incremented.
    const tmpPath = `${path}.tmp`
    writeFileSync(tmpPath, bytes)
    renameSync(tmpPath, path)
    const stat = statSync(path)
    return {
      accepted: [{ path, name, ext: safeExt, sizeBytes: stat.size }],
      rejected: [],
    }
  })

  registerHandle(
    'docs:save-new',
    async (_event: unknown, defaultName?: unknown, data?: unknown, projectId?: unknown) => {
      const name =
        (typeof defaultName === 'string' && defaultName) ||
        `文档-${new Date().toLocaleDateString()}.docx`
      const id = `doc-${randomFileId(name).split('-')[0]}`
      const path = join(FILES_DIR, `${id}.docx`)

      if (data) {
        // FILES_DIR is created at module load, but a `rm -rf` against
        // DATA_DIR (e.g. between test runs, or a misconfigured deploy)
        // would otherwise make writeFileSync throw ENOENT. Re-create the
        // parent before each write — mkdirSync({recursive:true}) is a
        // no-op when the directory already exists.
        mkdirSync(FILES_DIR, { recursive: true })
        writeFileSync(path, Buffer.from(data as ArrayBuffer))
      }

      if (typeof projectId === 'string' && projectId) {
        const projects = loadProjects()
        const project = projects.find((p) => p.id === projectId)
        if (project && !project.files.includes(`${id}.docx`)) {
          project.files.push(`${id}.docx`)
          project.updatedAt = Date.now()
          saveProjects(projects)
        }
      }

      return { id, path, name }
    },
  )

  registerHandle('docs:print', () => ({
    ok: true,
    message: '请使用浏览器的打印功能 (Ctrl+P 或 Cmd+P)',
  }))

  registerHandle('docs:consume-new-blank', () => false)
  registerHandle('docs:consume-pending-open', () => null)
  registerHandle('docs:consume-ai-doc-content', () => null)
  registerHandle('docs:write-recovery', () => ({ ok: true }))
  registerHandle('docs:password-intent-revision', () => 0)
}
