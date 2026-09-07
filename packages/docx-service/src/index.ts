import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  parseDocx,
  saveDocx,
  type ParsedDocFull,
  type SaveBlock,
  type SaveOptions,
} from '@genoffice/docx-engine'

export interface DocxFileServiceOptions {
  rootDir?: string
}

/** Node-safe DOCX read/validate/save boundary. No Electron or renderer state. */
export class DocxFileService {
  private readonly rootDir?: string

  constructor(options: DocxFileServiceOptions = {}) {
    this.rootDir = options.rootDir ? resolve(options.rootDir) : undefined
  }

  async read(filePath: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.allowed(filePath)))
  }

  async parse(filePath: string): Promise<ParsedDocFull> {
    return parseDocx(await this.read(filePath))
  }

  async validate(bytes: Uint8Array): Promise<{ blockCount: number }> {
    const parsed = await parseDocx(bytes)
    return { blockCount: parsed.blocks.length }
  }

  async save(
    filePath: string,
    parsed: ParsedDocFull,
    blocks: SaveBlock[],
    options?: SaveOptions,
  ): Promise<void> {
    const bytes = await saveDocx(parsed, blocks, options)
    await writeFile(this.allowed(filePath), bytes)
  }

  async saveBytes(filePath: string, bytes: Uint8Array): Promise<void> {
    await writeFile(this.allowed(filePath), bytes)
  }

  async roundTrip(sourcePath: string, targetPath: string): Promise<{ blockCount: number }> {
    const parsed = await this.parse(sourcePath)
    await this.save(
      targetPath,
      parsed,
      parsed.blocks
        .filter((block): block is typeof block & { docxIndex: number } => block.docxIndex !== null)
        .map((block) => ({ kind: 'original', docxIndex: block.docxIndex })),
    )
    return { blockCount: parsed.blocks.length }
  }

  private allowed(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') throw new Error('docx file path is required')
    const path = resolve(filePath)
    if (this.rootDir && path !== this.rootDir && !path.startsWith(`${this.rootDir}/`)) {
      throw new Error('docx file path is outside the configured root')
    }
    return path
  }
}
