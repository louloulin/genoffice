/**
 * Docs IPC channels for the library host. Mirrors the web-server handler set
 * (apps/web-server/src/docs/index.ts) minus the storage backend, recents
 * persistence, webhooks, version history and audit — a single-process library
 * has none of those. What remains is the real open → edit → save byte loop:
 *
 *   docs:open-path  read bytes → OpenFileResult (ArrayBuffer + sha256)
 *   docs:save       renderer's serialized docx → atomic write
 *   docs:save-new   new file under the workspace files dir
 *   docs:save-as    bytes → target path
 *   web:write-temp-file / web:read-file-bytes / web:make-temp-dir
 *   docs:recent     staged-document listing for the in-session grid
 *
 * Channel names, argument order and result shapes match the renderer's
 * DesktopApi exactly; only the storage target differs (workspace dir instead
 * of FILES_DIR + storage URIs).
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

import type { Registry } from '../registry'
import { OfficeError } from '../../errors'
import type { Workspace } from '../workspace'
import { fileSize, safeFileStem } from '../workspace'

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

interface RecentDoc {
  id: string
  path: string
  name: string
  openedAt: number
  modified: boolean
}

export interface DocsHandlerState {
  recent: RecentDoc[]
  settings: {
    language: string
    spellCheck: boolean
    autoSave: boolean
    autoSaveInterval: number
    fontSize: number
    fontFamily: string
  }
}

export function createDocsState(): DocsHandlerState {
  return {
    recent: [],
    settings: {
      language: 'zh-CN',
      spellCheck: true,
      autoSave: true,
      autoSaveInterval: 30000,
      fontSize: 14,
      fontFamily: 'sans-serif',
    },
  }
}

// CFB (OLE2) container + EncryptedPackage marker: ECMA-376 encrypted docx.
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const ENCRYPTED_STREAM_UTF16 = Buffer.from('EncryptedPackage', 'utf16le')

function isEncryptedDocx(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return buf.length >= 8 && buf.subarray(0, 8).equals(CFB_MAGIC) && buf.includes(ENCRYPTED_STREAM_UTF16)
}

function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/** Magic-byte gate: a docx must be a zip (or an encrypted CFB) before the renderer parses it. */
function assertDocxMagic(channel: string, filePath: string, bytes: Uint8Array): void {
  if (extname(filePath).toLowerCase() !== '.docx') return
  if (looksLikeZip(bytes) || isEncryptedDocx(bytes)) return
  throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: ${filePath} does not look like a .docx (bad magic bytes)`)
}

function bytesFrom(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }
  return null
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function registerDocsHandlers(registry: Registry, workspace: Workspace, state: DocsHandlerState): DocsHandlerState {
  const requirePath = (channel: string, filePath: unknown): string => {
    if (typeof filePath !== 'string' || !filePath) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: path must be a non-empty string`)
    }
    const resolved = workspace.resolvePath(filePath)
    if (!resolved) {
      throw new OfficeError('OFFICE_BAD_INPUT', `${channel}: ${filePath} is outside the office-ai workspace`)
    }
    return resolved
  }

  const openDocument = (channel: string, filePath: string, displayName: string) => {
    const absolute = requirePath(channel, filePath)
    if (!existsSync(absolute)) {
      throw new OfficeError('OFFICE_NOT_FOUND', `${channel}: file not found: ${filePath}`)
    }
    const bytes = workspace.readBytes(absolute)
    if (isEncryptedDocx(bytes)) {
      return { needsPassword: true, path: filePath, name: displayName }
    }
    assertDocxMagic(channel, absolute, bytes)
    return {
      path: filePath,
      name: displayName,
      data: toArrayBuffer(bytes),
      hash: sha256Hex(bytes),
      encrypted: false,
    }
  }

  registry.registerHandle('docs:open-path', (_event, filePath) => {
    const name = basename(String(filePath))
    const result = openDocument('docs:open-path', String(filePath), name)
    if ('needsPassword' in result) return result
    state.recent = [
      { id: `doc-${Date.now()}`, path: String(filePath), name, openedAt: Date.now(), modified: false },
      ...state.recent.filter((row) => row.path !== filePath),
    ].slice(0, 50)
    return result
  })

  registry.registerHandle('docs:read-path', (_event, filePath) => {
    if (typeof filePath !== 'string') return null
    const resolved = workspace.resolvePath(filePath)
    if (!resolved || !existsSync(resolved)) return null
    const bytes = workspace.readBytes(resolved)
    if (isEncryptedDocx(bytes)) return null
    return {
      name: state.recent.find((row) => row.path === filePath)?.name ?? basename(filePath),
      data: toArrayBuffer(bytes),
      hash: sha256Hex(bytes),
      encrypted: false,
    }
  })

  registry.registerHandle('docs:open', (_event, options) => {
    const opts = options as { docx?: unknown; path?: unknown } | undefined
    const bytes = bytesFrom(opts?.docx)
    if (!bytes || bytes.byteLength === 0) {
      return { id: '', path: '', name: '新文档.docx' }
    }
    const name = `${randomUUID().slice(0, 8)}-文档.docx`
    const path = join(workspace.filesDir, name)
    workspace.writeBytes(path, bytes)
    const id = basename(path, '.docx')
    state.recent = [{ id, path, name, openedAt: Date.now(), modified: false }, ...state.recent].slice(0, 50)
    return { id, path, name }
  })

  registry.registerHandle('docs:save', (event, filePath, data) => {
    if (typeof filePath !== 'string') return { ok: false, error: 'save target must be a string' }
    const absolute = workspace.resolvePath(filePath)
    if (!absolute) return { ok: false, error: 'save target is outside the office-ai workspace' }
    const bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) return { ok: false, error: 'save data is empty or invalid' }
    try {
      workspace.writeBytes(absolute, bytes)
      markModified(state, filePath)
      emitSaved(event, filePath, bytes.byteLength)
      return { ok: true, path: filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('docs:save-new', (event, defaultName, data) => {
    const safeName = safeFileStem(typeof defaultName === 'string' && defaultName ? defaultName : 'Untitled.docx')
    const bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) return { ok: false, error: 'save data is empty or invalid' }
    const stem = safeName.replace(/\.docx$/i, '') || 'Untitled'
    const fileName = `${randomUUID().slice(0, 8)}-${stem}.docx`
    const path = join(workspace.filesDir, fileName)
    try {
      workspace.writeBytes(path, bytes)
      const id = `doc-${basename(path, '.docx')}`
      state.recent = [{ id, path, name: safeName, openedAt: Date.now(), modified: false }, ...state.recent].slice(0, 50)
      emitSaved(event, path, bytes.byteLength)
      return { ok: true, id, path, name: safeName }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('docs:save-as', (event, sourcePath, targetPath, data) => {
    if (typeof sourcePath !== 'string' || !sourcePath) {
      throw new OfficeError('OFFICE_BAD_INPUT', 'docs:save-as: sourcePath must be a non-empty string')
    }
    const target = requirePath('docs:save-as', targetPath)
    let bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) {
      const source = workspace.resolvePath(sourcePath)
      if (!source || !existsSync(source)) {
        throw new OfficeError('OFFICE_NOT_FOUND', `docs:save-as: source not found: ${sourcePath}`)
      }
      bytes = workspace.readBytes(source)
    }
    try {
      workspace.writeBytes(target, bytes)
      emitSaved(event, String(targetPath), bytes.byteLength)
      return { ok: true, path: targetPath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registry.registerHandle('docs:recent', () => state.recent.map((row) => ({ ...row })))
  registry.registerHandle('docs:get-settings', () => ({ ...state.settings }))
  registry.registerHandle('docs:save-settings', (_event, patch) => {
    if (patch && typeof patch === 'object') {
      state.settings = { ...state.settings, ...(patch as Partial<DocsHandlerState['settings']>) }
    }
    return { ok: true }
  })
  registry.registerHandle('docs:font-metrics', (_event, family) => ({
    family: family || 'sans-serif',
    ascent: 0.8,
    descent: 0.2,
    lineGap: 0.1,
    unitsPerEm: 1000,
  }))
  registry.registerHandle('docs:pick-image', () => ({
    canceled: false,
    dataUrl: null,
    message: '请使用 Web File API 在前端选择图片',
  }))
  registry.registerHandle('docs:respell-kick', () => ({ ok: true, supported: false }))
  registry.registerHandle('docs:view-menu-state', () => ({ ok: true }))
  registry.registerHandle('docs:discard-password-intents', (_event, throughRevision) => ({
    ok: typeof throughRevision === 'number' && Number.isSafeInteger(throughRevision) && throughRevision >= 0,
  }))
  registry.registerHandle('docs:close-check-result', () => undefined)
  registry.registerHandle('docs:close-save-result', () => undefined)
  registry.registerHandle('docs:print', () => ({ ok: true, message: '请使用浏览器的打印功能 (Ctrl+P 或 Cmd+P)' }))
  registry.registerHandle('docs:consume-new-blank', () => false)
  registry.registerHandle('docs:consume-pending-open', () => null)
  registry.registerHandle('docs:consume-ai-doc-content', () => null)
  registry.registerHandle('docs:write-recovery', () => ({ ok: true }))
  registry.registerHandle('docs:password-intent-revision', () => 0)
  registry.registerHandle('docs:open-decrypt', () => ({
    ok: false,
    reason: 'error',
    error: 'WEB_UNSUPPORTED: password-protected DOCX requires the desktop renderer',
  }))
  registry.registerHandle('docs:set-password', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: DOCX password protection requires the desktop renderer',
  }))
  registry.registerHandle('docs:ai-generate-image', () => ({
    ok: false,
    error: 'WEB_UNSUPPORTED: image generation is not available in the office-ai UI host',
  }))
  registry.registerHandle('docs:create-document', () => ({ ok: false, error: 'unsupported' }))
  registry.registerHandle('docs:export-pdf', () => ({ ok: false, error: 'unsupported' }))
  registry.registerHandle('docs:save-merged-pdf', () => ({ ok: false, error: 'unsupported' }))
  registry.registerHandle('docs:copy-image-to-clipboard', () => ({ ok: false, error: 'clipboard-unavailable' }))

  // ----- web file channels (temp files + upload) ------------------------------
  registry.registerHandle('web:write-temp-file', (_event, payload) => {
    const value = payload as { name?: unknown; bytes?: unknown } | undefined
    const bytes = bytesFrom(value?.bytes)
    if (!bytes || bytes.byteLength === 0) throw new OfficeError('OFFICE_BAD_INPUT', 'web:write-temp-file: empty payload')
    return workspace.stageBytes(typeof value?.name === 'string' ? value.name : 'file', bytes)
  })

  registry.registerHandle('web:read-file-bytes', (_event, filePath) => {
    const absolute = requirePath('web:read-file-bytes', filePath)
    if (!existsSync(absolute)) throw new OfficeError('OFFICE_NOT_FOUND', `web:read-file-bytes: not found: ${filePath}`)
    const bytes = workspace.readBytes(absolute)
    return { name: basename(absolute), bytes: toArrayBuffer(bytes) }
  })

  registry.registerHandle('web:make-temp-dir', () => {
    const dir = join(workspace.tempDir, randomUUID().slice(0, 8))
    workspace.writeBytes(join(dir, '.keep'), new Uint8Array(0))
    return dir
  })

  registry.registerHandle('web:save-file', (_event, payload) => {
    const value = payload as { name?: unknown; bytes?: unknown } | undefined
    const bytes = bytesFrom(value?.bytes)
    if (!bytes || bytes.byteLength === 0) throw new OfficeError('OFFICE_BAD_INPUT', 'web:save-file: empty payload')
    const name = safeFileStem(typeof value?.name === 'string' ? value.name : 'upload') || 'upload'
    const path = join(workspace.filesDir, `${randomUUID().slice(0, 8)}-${name}`)
    workspace.writeBytes(path, bytes)
    return { id: basename(path), path, name }
  })

  registry.registerHandle('files:add-pasted-image', (_event, data, ext) => {
    const cleanExt = typeof ext === 'string' ? ext.toLowerCase().replace(/^\./, '') : ''
    if (!(IMAGE_EXTENSIONS as readonly string[]).includes(cleanExt)) {
      return { accepted: [], rejected: ['not an image'] }
    }
    const bytes = bytesFrom(data)
    if (!bytes || bytes.byteLength === 0) return { accepted: [], rejected: ['image data is empty'] }
    if (bytes.byteLength > MAX_PASTED_IMAGE_BYTES) return { accepted: [], rejected: ['image is too large'] }
    const name = `pasted-${randomUUID().slice(0, 8)}.${cleanExt}`
    const path = join(workspace.filesDir, name)
    workspace.writeBytes(path, bytes)
    return { accepted: [{ path, name, ext: cleanExt, sizeBytes: fileSize(path) }], rejected: [] }
  })

  registry.registerHandle('files:read', (_event, filePath) => {
    const absolute = workspace.resolvePath(String(filePath))
    if (!absolute || !existsSync(absolute)) return { ok: false, error: 'not found' }
    return { ok: true, name: basename(absolute), data: toArrayBuffer(workspace.readBytes(absolute)) }
  })

  return state
}

function markModified(state: DocsHandlerState, filePath: string): void {
  const row = state.recent.find((entry) => entry.path === filePath)
  if (row) row.modified = true
}

function emitSaved(event: unknown, path: string, size: number): void {
  const sender = (event as { sender?: { send?: (channel: string, ...args: unknown[]) => void } } | undefined)?.sender
  sender?.send?.('saved', { path, version: Date.now(), bytes: size, format: 'docx' })
}
