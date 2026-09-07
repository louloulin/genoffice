import { realpath, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { createBlankPptx, openPptx, savePptx, type OpenedPptx } from '@genoffice/pptx-engine'

export interface OfficeFileServiceOptions {
  rootDir: string
}

async function allowedPath(rootDir: string, filePath: string): Promise<string> {
  if (!filePath || typeof filePath !== 'string') throw new Error('office file path is required')
  const root = await realpath(rootDir)
  const path = resolve(filePath)
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error('office file path is outside the configured root')
  }
  const target = await realpath(path).catch(() => path)
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error('office file path resolves outside the configured root')
  }
  return path
}

export class SlidesFileService {
  constructor(private readonly options: OfficeFileServiceOptions) {}
  async createBlank(): Promise<Uint8Array> {
    return createBlankPptx()
  }
  async read(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await allowedPath(this.options.rootDir, filePath)))
  }
  async open(bytes: Uint8Array): Promise<OpenedPptx> {
    return openPptx(bytes)
  }
  async save(filePath: string, deck: OpenedPptx): Promise<void> {
    await writeFile(await allowedPath(this.options.rootDir, filePath), await savePptx(deck))
  }
  async write(filePath: string, bytes: Uint8Array): Promise<void> {
    await writeFile(await allowedPath(this.options.rootDir, filePath), bytes)
  }
}

export class PdfFileService {
  constructor(private readonly options: OfficeFileServiceOptions) {}
  async createBlank(): Promise<Uint8Array> {
    const document = await PDFDocument.create()
    document.addPage([595.28, 841.89])
    return new Uint8Array(await document.save())
  }
  async read(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(await allowedPath(this.options.rootDir, filePath)))
  }
  async validate(bytes: Uint8Array): Promise<{ pageCount: number }> {
    const document = await PDFDocument.load(bytes, { updateMetadata: false })
    return { pageCount: document.getPageCount() }
  }
  async save(filePath: string, bytes: Uint8Array): Promise<void> {
    await writeFile(await allowedPath(this.options.rootDir, filePath), bytes)
  }
}
