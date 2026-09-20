/**
 * The DocumentStore interface exists so the five save steps (sanitise, resolve
 * a directory, write, bump recents, attach to the project) happen once instead
 * of once per channel with a different subset right each time.
 *
 * These tests pin the shared steps and the per-format differences: docs land
 * in FILES_DIR, markdown and html in their own subdirectories, and every store
 * rejects bytes that are not really its format.
 */
import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import {
  DocsStore,
  HtmlStore,
  MarkdownStore,
  createDocumentStores,
  ensureExtension,
  looksLikePdf,
  looksLikeText,
  looksLikeZip,
  safeName,
  type DocumentStoreHost,
} from '../src/document-store'
import { UnifiedRecents } from '../src/recents'

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

function setup(overrides: Partial<DocumentStoreHost> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'genoffice-store-'))
  const filesDir = join(root, 'files')
  const dataDir = join(root, 'data')
  /* Stores create their own directories through atomicWriteFile, but the
   * fixtures below write directly, so the root has to exist up front. */
  mkdirSync(filesDir, { recursive: true })
  const host: DocumentStoreHost = {
    filesDir,
    dataDir,
    hashBytes: (bytes) => createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  }
  return { root, filesDir, dataDir, host }
}

describe('safeName', () => {
  it('keeps an ordinary name', () => {
    expect(safeName('report.docx', 'fallback')).toBe('report.docx')
  })

  it('strips a POSIX path traversal down to the basename', () => {
    expect(safeName('../../etc/passwd', 'fallback')).toBe('passwd')
  })

  it('strips a Windows path traversal down to the basename', () => {
    expect(safeName('..\\..\\windows\\system32\\evil.dll', 'fallback')).toBe('evil.dll')
  })

  it('drops control characters that would truncate a path at the syscall', () => {
    expect(safeName('a\u0000b.txt', 'fallback')).toBe('ab.txt')
  })

  it('strips a leading dot so the name cannot become a hidden file', () => {
    expect(safeName('.env', 'fallback')).toBe('env')
  })

  it('falls back when the result is empty', () => {
    expect(safeName('', 'fallback')).toBe('fallback')
    expect(safeName('   ', 'fallback')).toBe('fallback')
    expect(safeName(undefined, 'fallback')).toBe('fallback')
  })
})

describe('ensureExtension', () => {
  it('appends a missing extension', () => {
    expect(ensureExtension('report', '.docx')).toBe('report.docx')
  })

  it('leaves an existing extension alone', () => {
    expect(ensureExtension('report.docx', '.docx')).toBe('report.docx')
  })

  it('matches the extension case-insensitively', () => {
    expect(ensureExtension('REPORT.DOCX', '.docx')).toBe('REPORT.DOCX')
  })
})

describe('magic sniffers', () => {
  it('recognises a zip container', () => {
    expect(looksLikeZip(ZIP_MAGIC)).toBe(true)
  })

  it('rejects a non-zip payload', () => {
    expect(looksLikeZip(Buffer.from('plain text'))).toBe(false)
    expect(looksLikeZip(Buffer.from([0x50, 0x4b]))).toBe(false)
  })

  it('recognises a pdf header', () => {
    expect(looksLikePdf(Buffer.from('%PDF-1.7\n'))).toBe(true)
  })

  it('rejects a non-pdf payload', () => {
    expect(looksLikePdf(Buffer.from('not a pdf'))).toBe(false)
  })

  it('accepts text', () => {
    expect(looksLikeText(Buffer.from('# heading\n\nbody'))).toBe(true)
  })

  it('rejects binary content containing a NUL', () => {
    expect(looksLikeText(Buffer.from([0x41, 0x00, 0x42]))).toBe(false)
  })

  it('treats an empty buffer as text', () => {
    expect(looksLikeText(Buffer.alloc(0))).toBe(true)
  })
})

describe('DocsStore', () => {
  it('writes new documents into FILES_DIR, not a format subdirectory', async () => {
    const { filesDir, host } = setup()
    const meta = await new DocsStore(host).create({ name: 'new.docx' })
    expect(meta.path).toBe(join(filesDir, 'new.docx'))
    expect(existsSync(meta.path)).toBe(true)
  })

  it('produces a valid zip placeholder for a blank document', async () => {
    const { host } = setup()
    const meta = await new DocsStore(host).create({ name: 'blank.docx' })
    expect(looksLikeZip(readFileSync(meta.path))).toBe(true)
  })

  it('rejects created bytes that are not a zip container', async () => {
    const { host } = setup()
    await expect(
      new DocsStore(host).create({ name: 'fake.docx', bytes: Buffer.from('not a zip') }),
    ).rejects.toThrow(/not a valid \.docx container/)
  })

  it('rejects opening a file that is not really a docx', async () => {
    const { filesDir, host } = setup()
    const path = join(filesDir, 'liar.docx')
    writeFileSync(path, 'this is plain text')
    await expect(new DocsStore(host).open(path)).rejects.toThrow(/not a valid \.docx container/)
  })

  it('reports the format and mime type on the metadata', async () => {
    const { host } = setup()
    const meta = await new DocsStore(host).create({ name: 'typed.docx' })
    expect(meta.format).toBe('docx')
    expect(meta.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
  })

  it('reports a sha256 hash of the bytes it wrote', async () => {
    const { host } = setup()
    const bytes = Buffer.concat([ZIP_MAGIC, Buffer.from('payload')])
    const meta = await new DocsStore(host).create({ name: 'hashed.docx', bytes })
    expect(meta.hash).toBe(createHash('sha256').update(bytes).digest('hex'))
  })

  it('throws for a missing file on open', async () => {
    const { host, filesDir } = setup()
    await expect(new DocsStore(host).open(join(filesDir, 'ghost.docx'))).rejects.toThrow(
      /not found/,
    )
  })

  it('throws for an empty file on open', async () => {
    const { host, filesDir } = setup()
    const path = join(filesDir, 'empty.docx')
    writeFileSync(path, '')
    await expect(new DocsStore(host).open(path)).rejects.toThrow(/empty/)
  })

  it('refuses to save an empty buffer', async () => {
    const { host, filesDir } = setup()
    await expect(
      new DocsStore(host).save(join(filesDir, 'x.docx'), Buffer.alloc(0)),
    ).rejects.toThrow(RangeError)
  })

  it('refuses to save onto a path with the wrong extension', async () => {
    const { host, filesDir } = setup()
    await expect(new DocsStore(host).save(join(filesDir, 'x.txt'), ZIP_MAGIC)).rejects.toThrow(
      /expected a \.docx path/,
    )
  })
})

describe('MarkdownStore', () => {
  it('writes into its own subdirectory', async () => {
    const { dataDir, host } = setup()
    const meta = await new MarkdownStore(host).create({ name: 'notes.md' })
    expect(meta.path).toBe(join(dataDir, 'markdown', 'notes.md'))
  })

  it('seeds a heading derived from the file name', async () => {
    const { host } = setup()
    const meta = await new MarkdownStore(host).create({ name: 'my-notes.md' })
    expect(readFileSync(meta.path, 'utf-8')).toBe('# my-notes\n')
  })

  it('rejects binary content as "not markdown"', async () => {
    const { host } = setup()
    await expect(
      new MarkdownStore(host).create({ name: 'bin.md', bytes: Buffer.from([0x00, 0x01, 0x02]) }),
    ).rejects.toThrow(/not a valid \.md container/)
  })

  it('round-trips saved text through open()', async () => {
    const { host } = setup()
    const store = new MarkdownStore(host)
    const meta = await store.create({ name: 'round.md', bytes: Buffer.from('# round\n') })
    const opened = await store.open(meta.path)
    expect(opened.bytes.toString('utf-8')).toBe('# round\n')
  })
})

describe('HtmlStore', () => {
  it('writes into ${dataDir}/html/', async () => {
    const { dataDir, host } = setup()
    const meta = await new HtmlStore(host).create({ name: 'page.html' })
    expect(meta.path).toBe(join(dataDir, 'html', 'page.html'))
  })

  it('seeds a complete document with the title in it', async () => {
    const { host } = setup()
    const meta = await new HtmlStore(host).create({ name: 'about.html' })
    const text = readFileSync(meta.path, 'utf-8')
    expect(text).toContain('<!doctype html>')
    expect(text).toContain('<title>about</title>')
  })
})

describe('shared save behaviour', () => {
  it('records the save in recents when a recents store is wired in', async () => {
    const recentsFile = join(mkdtempSync(join(tmpdir(), 'genoffice-recents-')), 'recents.json')
    const recents = new UnifiedRecents(recentsFile)
    const { host, filesDir } = setup({ recents })
    const meta = await new DocsStore(host).create({ name: 'tracked.docx' })
    await new DocsStore(host).save(meta.path, concat(ZIP_MAGIC, 'v2'))
    const entry = recents.get(meta.path)
    expect(entry).toBeDefined()
    expect(entry!.modified).toBe(true)
    void filesDir
  })

  it('attaches the saved path to the project when projectId is given', async () => {
    const attachToProject = vi.fn()
    const { host, filesDir } = setup({ attachToProject })
    await new DocsStore(host).save(join(filesDir, 'proj.docx'), ZIP_MAGIC, { projectId: 'proj-1' })
    expect(attachToProject).toHaveBeenCalledWith('proj-1', join(filesDir, 'proj.docx'))
  })

  it('does not call attachToProject without a projectId', async () => {
    const attachToProject = vi.fn()
    const { host, filesDir } = setup({ attachToProject })
    await new DocsStore(host).save(join(filesDir, 'noproj.docx'), ZIP_MAGIC)
    expect(attachToProject).not.toHaveBeenCalled()
  })

  it('still saves when no recents store is configured', async () => {
    const { host, filesDir } = setup()
    const target = join(filesDir, 'standalone.docx')
    const result = await new DocsStore(host).save(target, ZIP_MAGIC)
    expect(result.ok).toBe(true)
    expect(existsSync(target)).toBe(true)
  })

  it('open() touches recents with modified: false', async () => {
    const recentsFile = join(mkdtempSync(join(tmpdir(), 'genoffice-recents-')), 'recents.json')
    const recents = new UnifiedRecents(recentsFile)
    const { host } = setup({ recents })
    const meta = await new DocsStore(host).create({ name: 'opened.docx' })
    await recents.remove(meta.path)
    await new DocsStore(host).open(meta.path)
    expect(recents.get(meta.path)?.modified).toBe(false)
  })

  it('gives every created document a distinct id', async () => {
    const { host } = setup()
    const store = new DocsStore(host)
    const ids = new Set<string>()
    for (let i = 0; i < 5; i += 1) ids.add((await store.create({ name: `many-${i}.docx` })).id)
    expect(ids.size).toBe(5)
  })

  it('appends the extension to a name the caller left off', async () => {
    const { host } = setup()
    const meta = await new DocsStore(host).create({ name: 'no-extension' })
    expect(meta.name).toBe('no-extension.docx')
  })

  it('defuses a traversal in the requested name', async () => {
    const { filesDir, host } = setup()
    const meta = await new DocsStore(host).create({ name: '../../escape.docx' })
    expect(meta.path).toBe(join(filesDir, 'escape.docx'))
  })
})

describe('createDocumentStores', () => {
  it('returns one store per format sharing the same host', () => {
    const { host } = setup()
    const stores = createDocumentStores(host)
    expect(stores.docs.format).toBe('docx')
    expect(stores.markdown.format).toBe('md')
    expect(stores.html.format).toBe('html')
  })
})

function concat(a: Buffer, b: string): Buffer {
  return Buffer.concat([a, Buffer.from(b)])
}
