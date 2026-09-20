/**
 * The per-format document store: one place that knows how a `.docx` (or `.md`,
 * `.html`, …) is created, opened, and saved.
 *
 * Before this, every channel re-implemented the same five steps — sanitise the
 * name, resolve a directory, write, bump recents, attach to the project — and
 * each copy got a different subset right. `docs:save` wrote recents but not the
 * project; `markdown:save` wrote the project but not recents; a new format
 * copied whichever neighbour it was written next to. Concentrating the steps
 * in `BaseDocumentStore` means a new format supplies only what actually
 * differs: its magic bytes, its initial content, and its MIME type.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWriteFile } from './atomic'
import type { UnifiedRecents } from './recents'

export interface DocumentMeta {
  id: string
  /** Absolute path on disk. */
  path: string
  /** Basename, extension included. */
  name: string
  sizeBytes: number
  mtimeMs: number
  format: string
  mimeType: string
  /** sha256 hex of the bytes as they were read/written. */
  hash: string
}

export interface CreatedDocument extends DocumentMeta {
  bytes: Buffer
}

export interface SaveResult {
  ok: true
  meta: DocumentMeta
}

export interface CreateOptions {
  /** Caller-preferred name; sanitised and extension-corrected. */
  name?: string
  /** Directory override. Defaults to the store's `defaultDir()`. */
  dir?: string
  projectId?: string
  /** Seed content. Defaults to the store's `initialBytes()`. */
  bytes?: Buffer
}

/** The collaborator surface a store needs. Kept narrow so a store can be
 *  unit-tested without a project registry or a recents file. */
export interface DocumentStoreHost {
  filesDir: string
  dataDir: string
  recents?: UnifiedRecents
  /** Record `path` against `projectId`; a no-op when the project is unknown. */
  attachToProject?: (projectId: string, path: string) => void
  /** sha256 of a buffer; injectable so tests need not hash large fixtures. */
  hashBytes: (bytes: Buffer) => string
}

export interface DocumentStore<TExtras = Record<string, never>> {
  readonly format: string
  readonly dirName: string
  readonly extension: string
  readonly mimeType: string

  create(opts?: CreateOptions): Promise<DocumentMeta>
  open(path: string): Promise<{ meta: DocumentMeta & TExtras; bytes: Buffer }>
  save(path: string, payload: Buffer, opts?: { projectId?: string }): Promise<SaveResult>
  recentTouch(path: string): Promise<void>
}

/**
 * Strip anything that could move a write out of its directory.
 *
 * The renderer supplies file names, so `../` , an absolute path, and control
 * characters all have to be defused before the name is joined onto a managed
 * directory. Anything left empty falls back to the supplied default.
 */
export function safeName(name: string | undefined, fallback: string): string {
  const raw = (name ?? '').trim()
  if (!raw) return fallback
  /* Take the basename under both separator conventions: a Windows-style
   * `..\..\x.docx` must not survive on a POSIX host either. */
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    /* eslint-disable-next-line no-control-regex -- stripping control chars is
     * the point: a NUL truncates the path at the syscall boundary. */
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim()
  return cleaned || fallback
}

/** Append `extension` unless the name already carries it (case-insensitively). */
export function ensureExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension.toLowerCase()) ? name : `${name}${extension}`
}

export abstract class BaseDocumentStore<
  TExtras = Record<string, never>,
> implements DocumentStore<TExtras> {
  abstract readonly format: string
  abstract readonly dirName: string
  abstract readonly extension: string
  abstract readonly mimeType: string

  constructor(protected readonly host: DocumentStoreHost) {}

  /** True when `bytes` really are this format. */
  protected abstract verifyMagic(bytes: Buffer): boolean
  /** Content for a brand-new empty document. */
  protected abstract initialBytes(name: string): Buffer
  /** Where newly-created documents land. */
  protected defaultDir(): string {
    return join(this.host.dataDir, this.dirName)
  }

  /** A stable, collision-free id. The random suffix is what stops two saves in
   *  the same millisecond from overwriting each other. */
  protected makeId(): string {
    return `${this.dirName}-${Date.now()}-${randomUUID().slice(0, 8)}`
  }

  private toMeta(id: string, path: string, bytes: Buffer): DocumentMeta {
    const stats = statSync(path)
    return {
      id,
      path,
      name: basename(path),
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
      format: this.format,
      mimeType: this.mimeType,
      hash: this.host.hashBytes(bytes),
    }
  }

  async create(opts: CreateOptions = {}): Promise<DocumentMeta> {
    const dir = opts.dir ?? this.defaultDir()
    const name = ensureExtension(
      safeName(opts.name, `${this.format}-${Date.now()}`),
      this.extension,
    )
    const path = join(dir, name)
    const bytes = opts.bytes ?? this.initialBytes(name)
    if (!this.verifyMagic(bytes)) {
      throw new Error(
        `${this.format}: create rejected bytes that are not a valid ${this.extension} container`,
      )
    }
    /* atomicWriteFile mkdirs the parent, so a first save into a fresh
     * project directory works without a separate setup step. */
    atomicWriteFile(path, bytes)
    const meta = this.toMeta(this.makeId(), path, bytes)
    await this.recentTouch(path, { projectId: opts.projectId, modified: true })
    if (opts.projectId) this.host.attachToProject?.(opts.projectId, path)
    return meta
  }

  async open(path: string): Promise<{ meta: DocumentMeta & TExtras; bytes: Buffer }> {
    if (!existsSync(path)) throw new Error(`${this.format}: file not found: ${path}`)
    const bytes = readFileSync(path)
    if (bytes.byteLength === 0) throw new Error(`${this.format}: file is empty: ${path}`)
    /* `open` validates magic for the same reason `create` does: a .docx that
     * is really a JPEG parses into a confusing downstream error, and the
     * extension is caller-supplied. */
    if (!this.verifyMagic(bytes)) {
      throw new Error(
        `${this.format}: ${basename(path)} is not a valid ${this.extension} container`,
      )
    }
    const meta = this.toMeta(this.makeId(), path, bytes)
    await this.recentTouch(path)
    return { meta: meta as DocumentMeta & TExtras, bytes }
  }

  async save(
    path: string,
    payload: Buffer,
    opts: { projectId?: string } = {},
  ): Promise<SaveResult> {
    if (payload.byteLength === 0) {
      throw new RangeError(`${this.format}: refusing to save an empty buffer to ${path}`)
    }
    if (extname(path).toLowerCase() !== this.extension) {
      throw new Error(`${this.format}: expected a ${this.extension} path, got ${basename(path)}`)
    }
    atomicWriteFile(path, payload)
    const meta = this.toMeta(this.makeId(), path, payload)
    await this.recentTouch(path, { projectId: opts.projectId, modified: true })
    if (opts.projectId) this.host.attachToProject?.(opts.projectId, path)
    return { ok: true, meta }
  }

  async recentTouch(
    path: string,
    opts: { projectId?: string; modified?: boolean } = {},
  ): Promise<void> {
    if (!this.host.recents) return
    await this.host.recents.add(path, {
      name: basename(path),
      modified: opts.modified ?? false,
      projectId: opts.projectId,
    })
  }
}

/** ZIP container magic — docx/xlsx/pptx are all OOXML zips. */
export function looksLikeZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  )
}

/** `%PDF-` prefix. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-'
}

/** A UTF-8 text payload: no NUL byte and mostly printable. Used by the
 *  markdown and html stores, whose formats have no magic of their own. */
export function looksLikeText(bytes: Buffer): boolean {
  if (bytes.length === 0) return true
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096))
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const b = sample[i]
    if (b === 0) return false
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e) || b >= 0x80) {
      printable += 1
    }
  }
  return printable / sample.length >= 0.85
}

export class DocsStore extends BaseDocumentStore {
  readonly format = 'docx'
  readonly dirName = 'docs'
  readonly extension = '.docx'
  readonly mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  protected verifyMagic(bytes: Buffer): boolean {
    return looksLikeZip(bytes)
  }

  protected initialBytes(_name: string): Buffer {
    /* A placeholder OOXML container: enough for the renderer to open and
     * immediately replace with a real document on first save. */
    return Buffer.from([0x50, 0x4b, 0x03, 0x04])
  }

  /** Docs live in FILES_DIR, not a format subdirectory, because the renderer
   *  and the recents watcher both expect docx files at the top level. */
  protected defaultDir(): string {
    return this.host.filesDir
  }
}

export class MarkdownStore extends BaseDocumentStore {
  readonly format = 'md'
  readonly dirName = 'markdown'
  readonly extension = '.md'
  readonly mimeType = 'text/markdown'

  protected verifyMagic(bytes: Buffer): boolean {
    return looksLikeText(bytes)
  }

  protected initialBytes(name: string): Buffer {
    return Buffer.from(`# ${name.replace(/\.md$/i, '')}\n`, 'utf-8')
  }
}

export class HtmlStore extends BaseDocumentStore {
  readonly format = 'html'
  readonly dirName = 'html'
  readonly extension = '.html'
  readonly mimeType = 'text/html'

  protected verifyMagic(bytes: Buffer): boolean {
    return looksLikeText(bytes)
  }

  protected initialBytes(name: string): Buffer {
    const title = basename(name, '.html')
    return Buffer.from(
      `<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n</body>\n</html>\n`,
      'utf-8',
    )
  }

  /** HTML is written into `${DATA_DIR}/html/` (not FILES_DIR) to match the
   *  layout `html:save` has always used. */
  protected defaultDir(): string {
    return join(this.host.dataDir, 'html')
  }
}

export function createDocumentStores(host: DocumentStoreHost): {
  docs: DocsStore
  markdown: MarkdownStore
  html: HtmlStore
} {
  return {
    docs: new DocsStore(host),
    markdown: new MarkdownStore(host),
    html: new HtmlStore(host),
  }
}

/** Re-exported so a store implementation living in another package can build
 *  a directory without importing node:path itself. */
export { mkdirSync }
