/**
 * Project CRUD channels — list, create, files, rename, delete, move-file,
 * timeline. Persistence is delegated to the shared `state.ts` helpers so
 * the file format matches the legacy single-file implementation exactly.
 */
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import {
  FILES_DIR,
  FILES_INDEX,
  MIME_TYPES,
  fileIndexStore,
  loadProjects,
  recordRecentDoc,
  registerHandle,
  sanitizeFileName,
  saveProjects,
} from '../common/index'
import type { FileInfo } from '../common/index'
import { atomicWriteFile } from '../common/atomic'
import { InvalidArgumentError, NotFoundError } from '../ai/errors'
import { getStorageBackend } from '../common/state'

/** Same cap as `web:save-file` — keeps the two channels consistent so the
 *  renderer never silently truncates one file but not the other. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Try to derive a sane display name from a FILES_INDEX row, falling back to
 *  parsing the id only when the row is missing (legacy on-disk files). */
function displayNameFor(fileId: string): string {
  const info = FILES_INDEX.get(fileId)
  if (info?.name) return info.name
  // legacy fallback: drop the leading "<counter>-" / "file-" prefix
  return fileId.replace(/^(?:\d+-|\d+-|file-)/, '')
}

type ChatMessage = {
  role: 'user' | 'assistant'
  text: string
  tools?: unknown[]
  attachments?: unknown[]
  createdAt: number
}

const CHAT_HISTORY = new Map<string, ChatMessage[]>()

export function registerProjectHandlers(): void {
  registerHandle('project:resolveChat', (_event: unknown, args: unknown) => {
    const request = (args || {}) as { filePath?: string | null; tempChatId?: string }
    return {
      projectId: 'default',
      chatId:
        request.tempChatId ||
        (request.filePath
          ? `chat-${Buffer.from(request.filePath).toString('base64url').slice(0, 32)}`
          : `unsaved-${Date.now()}`),
    }
  })

  registerHandle('project:appendChat', (_event: unknown, args: unknown) => {
    const request = args as {
      projectId: string
      chatId: string
      role: 'user' | 'assistant'
      text: string
      tools?: unknown[]
      attachments?: unknown[]
    }
    const key = `${request.projectId}:${request.chatId}`
    const messages = CHAT_HISTORY.get(key) || []
    messages.push({
      role: request.role,
      text: request.text,
      tools: request.tools,
      attachments: request.attachments,
      createdAt: Date.now(),
    })
    CHAT_HISTORY.set(key, messages)
  })

  registerHandle('project:loadChat', (_event: unknown, args: unknown) => {
    const request = args as { projectId: string; chatId: string; limit?: number }
    const messages = CHAT_HISTORY.get(`${request.projectId}:${request.chatId}`) || []
    return messages.slice(-(request.limit || 200))
  })

  registerHandle('project:rebindChat', (_event: unknown, args: unknown) => {
    const request = args as { projectId: string; tempChatId: string; newChatId?: string }
    const chatId = request.newChatId || request.tempChatId
    const oldKey = `${request.projectId}:${request.tempChatId}`
    const newKey = `${request.projectId}:${chatId}`
    if (oldKey !== newKey && CHAT_HISTORY.has(oldKey)) {
      CHAT_HISTORY.set(newKey, CHAT_HISTORY.get(oldKey) || [])
      CHAT_HISTORY.delete(oldKey)
    }
    return { projectId: request.projectId, chatId }
  })

  registerHandle('project:list', () => loadProjects())

  registerHandle('project:create', (_event: unknown, args: unknown) => {
    const { name } = args as { name: string }
    const projects = loadProjects()
    /* The first project ever created gets the well-known default id
     * "proj-default" so the seed path stays in sync. Subsequent projects
     * always get a unique id — silently deduping on name hid user intent
     * ("I clicked New Project") and surprised the UI with phantom rows. */
    const cleanName = (name || '新项目').trim() || '新项目'
    const isFirst = projects.length === 0
    const project = {
      id: isFirst ? 'proj-default' : `proj-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: cleanName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      files: [],
    }
    projects.push(project)
    saveProjects(projects)
    return project
  })

  registerHandle('project:files', (_event: unknown, args: unknown) => {
    const { projectId } = args as { projectId: string }
    const projects = loadProjects()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return []

    return project.files
      .map((fileId) => {
        const filePath = join(FILES_DIR, fileId)
        if (!existsSync(filePath)) return null
        const stats = statSync(filePath)
        const info = FILES_INDEX.get(fileId)
        /* Prefer the FILES_INDEX row so files uploaded via web:save-file
         * (id = "<counter>-<ts>-<rand>-<name>") and files:create
         * (id = "file-<ts>") both show their real name, not a stripped id. */
        return {
          id: fileId,
          name: info?.name ?? displayNameFor(fileId),
          path: filePath,
          size: stats.size,
          mimeType: info?.mimeType ?? (MIME_TYPES[extname(fileId).toLowerCase()] || 'application/octet-stream'),
          projectId,
          createdAt: info?.createdAt ?? stats.birthtimeMs,
          updatedAt: info?.updatedAt ?? stats.mtimeMs,
        }
      })
      .filter(Boolean) as FileInfo[]
  })

  registerHandle('project:rename', (_event: unknown, args: unknown) => {
    const { id, name } = args as { id: string; name: string }
    const projects = loadProjects()
    const project = projects.find((p) => p.id === id)
    if (project) {
      project.name = name
      project.updatedAt = Date.now()
      saveProjects(projects)
      return { ok: true }
    }
    return { ok: false, error: 'Project not found' }
  })

  registerHandle('project:delete', (_event: unknown, args: unknown) => {
    const { id } = args as { id: string }
    const projects = loadProjects()
    const index = projects.findIndex((p) => p.id === id)
    if (index >= 0) {
      const project = projects[index]
      for (const fileId of project.files) {
        const filePath = join(FILES_DIR, fileId)
        if (existsSync(filePath)) unlinkSync(filePath)
      }
      projects.splice(index, 1)
      saveProjects(projects)
      return { ok: true }
    }
    return { ok: false, error: 'Project not found' }
  })

  registerHandle('project:moveFile', (_event: unknown, args: unknown) => {
    const { filePath, projectId } = args as { filePath: string; projectId: string }
    const projects = loadProjects()
    const target = projects.find((p) => p.id === projectId)
    if (!target) return { ok: false, error: 'Project not found' }

    const fileId = basename(filePath)
    /* The web model stores each file in exactly one project. If the file is
     * currently listed under another project, drop it from there first so
     * the move is symmetric with the Electron `ProjectStore.moveFileToProject`
     * behaviour — otherwise dragging the same row between projects would
     * leave the source row behind and silently grow the file count. */
    for (const p of projects) {
      if (p.id !== target.id && p.files.includes(fileId)) {
        p.files = p.files.filter((f) => f !== fileId)
        p.updatedAt = Date.now()
      }
    }
    if (!target.files.includes(fileId)) {
      target.files.push(fileId)
      target.updatedAt = Date.now()
    }
    saveProjects(projects)
    return { ok: true }
  })

  registerHandle('project:timeline', (_event: unknown, args: unknown) => {
    const { projectId } = args as { projectId: string }
    const projects = loadProjects()
    const project = projects.find((p) => p.id === projectId)
    if (!project) return []
    return [
      {
        id: `event-${Date.now()}`,
        type: 'created',
        message: '项目已创建',
        timestamp: project.createdAt,
      },
      {
        id: `event-${Date.now() + 1}`,
        type: 'updated',
        message: '项目已更新',
        timestamp: project.updatedAt,
      },
    ]
  })

  /**
   * Dedicated upload-to-project channel: takes one or more files (already
   * read into memory on the renderer side via `pickFileBytes`), lands each
   * one atomically in FILES_DIR, indexes it so `files:read({id})` can resolve
   * it after a restart, and attaches the id to the named project. Mirrors
   * `web:save-file` semantically, but:
   *   - never opens a tab (this is the pure-upload path the Home FAB uses);
   *   - always requires a projectId (or falls back to `proj-default`);
   *   - reports per-file outcomes so the renderer can show a partial-success
   *     toast instead of one large "failed" alert that hides the 9/10 files
   *     that did land.
   */
  registerHandle('project:upload', async (_event: unknown, args: unknown) => {
    const request = (args || {}) as {
      files?: Array<{ name?: unknown; bytes?: unknown; mimeType?: unknown }>
      projectId?: string | null
    }
    const incoming = Array.isArray(request.files) ? request.files : []
    if (incoming.length === 0) {
      throw new InvalidArgumentError('project:upload', 'files must be a non-empty array')
    }

    const projects = loadProjects()
    const fallbackId = projects[0]?.id
    const targetId = request.projectId && projects.some((p) => p.id === request.projectId)
      ? request.projectId
      : fallbackId
    if (!targetId) {
      throw new NotFoundError('project:upload', 'no projects exist to receive the upload')
    }
    const target = projects.find((p) => p.id === targetId)!

    const uploaded: Array<{
      id: string
      name: string
      path: string
      size: number
      mimeType: string
      projectId: string
    }> = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const entry of incoming) {
      const rawName = typeof entry.name === 'string' ? entry.name : ''
      /* The IPC transport decoder only unwraps `tag=b64` records at the top
       * level of an `args` entry — the nested `entry.bytes` arrives still
       * tagged. Decode it here so the validation below sees real bytes. */
      const taggedBytes = entry.bytes as { tag?: unknown; b64?: unknown } | null
      let entryBytes: unknown = entry.bytes
      if (
        taggedBytes &&
        typeof taggedBytes === 'object' &&
        typeof taggedBytes.tag === 'string' &&
        typeof taggedBytes.b64 === 'string'
      ) {
        entryBytes = Buffer.from(taggedBytes.b64, 'base64')
      }
      /* Accept ArrayBuffer (over HTTP/JSON), Uint8Array (browser FileReader),
       * Node Buffer, and plain string (a debug fallback). Anything else
       * (null, undefined, an object) is rejected with a clear reason. */
      let bytes: Buffer
      if (entryBytes instanceof ArrayBuffer) {
        bytes = Buffer.from(entryBytes)
      } else if (entryBytes instanceof Uint8Array) {
        bytes = Buffer.from(entryBytes)
      } else if (typeof entryBytes === 'string') {
        bytes = Buffer.from(entryBytes, 'utf-8')
      } else if (entryBytes && typeof (entryBytes as { byteLength?: unknown }).byteLength === 'number') {
        bytes = Buffer.from(entryBytes as ArrayBufferView)
      } else {
        skipped.push({ name: rawName, reason: 'invalid bytes' })
        continue
      }
      if (bytes.byteLength === 0) {
        skipped.push({ name: rawName, reason: 'empty file' })
        continue
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        skipped.push({ name: rawName, reason: `exceeds ${MAX_UPLOAD_BYTES}-byte cap` })
        continue
      }
      const safeName = sanitizeFileName(rawName, 'file')
      const fileId = fileIndexStore.nextId(safeName)
      const mimeType = typeof entry.mimeType === 'string'
        ? entry.mimeType
        : (MIME_TYPES[extname(safeName).toLowerCase()] || 'application/octet-stream')
      /* Storage goes through the active backend (local FS by default; mimo
       * or S3 when GENOFFICE_STORAGE is set). The temp-and-rename kernel
       * lives in the backend so this channel stays storage-agnostic. */
      let stored: { key: string; size: number }
      try {
        stored = await getStorageBackend().put(fileId, new Uint8Array(bytes), { contentType: mimeType })
      } catch (err) {
        skipped.push({ name: rawName, reason: err instanceof Error ? err.message : 'write failed' })
        continue
      }
      const info: FileInfo = {
        id: fileId,
        name: safeName,
        path: `storage://${getStorageBackend().id}/${fileId}`,
        size: stored.size,
        mimeType,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      fileIndexStore.set(info)
      if (!target.files.includes(fileId)) target.files.push(fileId)
      target.updatedAt = Date.now()
      uploaded.push({ ...info, projectId: target.id })
      /* Mirror into recents so the home tab also surfaces the file. Awaited
       * so the caller cannot observe the row as missing. */
      await recordRecentDoc(info.path, {
        id: basename(fileId, extname(fileId)),
        name: safeName,
        modified: false,
        projectId: target.id,
      })
    }
    await fileIndexStore.flushNow()
    saveProjects(projects)
    return { ok: true, uploaded, skipped, projectId: target.id }
  })
}
