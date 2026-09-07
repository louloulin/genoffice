import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createStandaloneWebServer, type IpcHandlerRegistry } from '@genoffice/ipc-bridge'
import { DocxFileService } from '@genoffice/docx-service'
import { PdfFileService, SlidesFileService } from '@genoffice/office-file-service'
import {
  fontCoversText,
  isSignatureData,
  SignatureService,
  subsetTtf,
  uniqueGeneratedPdfPath,
} from '@genoffice/pdf-export-service'
import {
  audioSampleFormats,
  cfbKind,
  displayMime,
  FONT_CATALOG,
  neutralizeJpegOrientation,
  tiffToPng,
  unplayableAudioCodec,
} from '@genoffice/slides-render-service'
import {
  UnavailableWorkbookBackend,
  WorkbookFileService,
  XlsxSidecarBackend,
  type WorkbookBackend,
} from '@genoffice/workbook-service'
import {
  MarkdownFileService,
  ProjectStore,
  registerMarkdownProjectHandlers,
} from '@genoffice/project-store'
import { createAiService, registerAiHandlers, type AiService } from './ai.js'

export interface WebCompositionOptions {
  host?: string
  port?: number
  dataDir?: string
  staticDir?: string
  authToken?: string
  xlsxSidecarPath?: string
  workbookBackend?: WorkbookBackend
  aiService?: AiService
}

function defaultSidecarPath(): string | undefined {
  const candidates = [
    process.env.XLSX_SIDECAR_PATH,
    join(
      dirname(new URL(import.meta.url).pathname),
      '../../sheets/native/xlsx-engine/target/release/xlsx-sidecar',
    ),
    join(process.cwd(), 'apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar'),
  ].filter((path): path is string => Boolean(path))
  const found = candidates.find((path) => existsSync(path))
  if (found) return found
  return undefined
}
export async function createWebComposition(options: WebCompositionOptions = {}) {
  const dataDir = resolve(options.dataDir ?? process.env.GENOFFICE_DATA_DIR ?? '.genoffice-data')
  await mkdir(dataDir, { recursive: true })
  const markdown = new MarkdownFileService({ rootDir: dataDir })
  const projects = new ProjectStore(dataDir)
  const docx = new DocxFileService({ rootDir: dataDir })
  const office = {
    slides: new SlidesFileService({ rootDir: dataDir }),
    pdf: new PdfFileService({ rootDir: dataDir }),
  }
  const sidecarPath = options.xlsxSidecarPath ?? defaultSidecarPath()
  const workbook = new WorkbookFileService(
    options.workbookBackend ??
      (sidecarPath
        ? new XlsxSidecarBackend(sidecarPath)
        : new UnavailableWorkbookBackend(
            'Workbook backend unavailable; build xlsx-sidecar or set XLSX_SIDECAR_PATH',
          )),
    dataDir,
  )
  const { server, registry } = await createStandaloneWebServer({
    host: options.host ?? process.env.HOST ?? '127.0.0.1',
    port: options.port ?? Number(process.env.PORT ?? 5273),
    staticDir: options.staticDir,
    authToken: options.authToken,
  })
  registerMarkdownProjectHandlers(registry, {
    readFile: (path) => markdown.read(path),
    writeFile: (path, content) => markdown.write(path, content),
    listProjects: () => projects.listProjectsSummary(),
    createProject: (name) => projects.createProject(name),
  })
  registerDocxHandlers(registry, docx)
  registerOfficeHandlers(registry, office, workbook)
  const signatures = new SignatureService(dataDir)
  registerPdfExportHandlers(registry, signatures, dataDir)
  registerSlidesRenderHandlers(registry)
  registerAiHandlers(registry, options.aiService ?? createAiService())
  return {
    server,
    registry,
    services: { markdown, projects, docx, ...office, workbook, signatures },
  }
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return null
}
function registerOfficeHandlers(
  registry: IpcHandlerRegistry,
  office: { slides: SlidesFileService; pdf: PdfFileService },
  workbook: WorkbookFileService,
): void {
  registry.registerHandle('slides:create-blank', () => office.slides.createBlank())
  registry.registerHandle('slides:read-file', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('slides:read-file expects a path')
    return office.slides.read(path)
  })
  registry.registerHandle('slides:inspect-file', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('slides:inspect-file expects a path')
    const deck = await office.slides.open(await office.slides.read(path))
    return { slideCount: deck.deck.slides.length, size: deck.deck.size }
  })
  registry.registerHandle('slides:save-file', async (_event, path: unknown, bytes: unknown) => {
    if (typeof path !== 'string' || !asBytes(bytes))
      throw new Error('slides:save-file expects path and bytes')
    return office.slides.write(path, asBytes(bytes)!)
  })
  registry.registerHandle('pdf:create-blank', () => office.pdf.createBlank())
  registry.registerHandle('pdf:read-file', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('pdf:read-file expects a path')
    return office.pdf.read(path)
  })
  registry.registerHandle('pdf:save-file', async (_event, path: unknown, bytes: unknown) => {
    if (typeof path !== 'string' || !asBytes(bytes))
      throw new Error('pdf:save-file expects path and bytes')
    return office.pdf.save(path, asBytes(bytes)!)
  })
  registry.registerHandle('pdf:validate-bytes', (_event, bytes: unknown) => {
    const value = asBytes(bytes)
    if (!value) throw new Error('pdf:validate-bytes expects bytes')
    return office.pdf.validate(value)
  })
  registry.registerHandle('workbook:read-file', (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('workbook:read-file expects a path')
    return workbook.read(path)
  })
  registry.registerHandle('workbook:write-file', (_event, path: unknown, bytes: unknown) => {
    if (typeof path !== 'string' || !asBytes(bytes))
      throw new Error('workbook:write-file expects path and bytes')
    return workbook.write(path, asBytes(bytes)!)
  })
  registry.registerHandle('workbook:open', (_event, path: unknown, locale?: unknown) => {
    if (typeof path !== 'string') throw new Error('workbook:open expects a path')
    return workbook.open(path, typeof locale === 'string' ? locale : undefined)
  })
  registry.registerHandle('workbook:read-range', (_event, input: unknown) =>
    workbook.readRange(input),
  )
  registry.registerHandle('workbook:close', (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string') throw new Error('workbook:close expects sessionId')
    return workbook.close(sessionId)
  })
}

/**
 * PDF export/print capabilities that need no Electron: font coverage probing
 * and subsetting, both driven by the renderer before an export.
 */
function registerPdfExportHandlers(
  registry: IpcHandlerRegistry,
  signatures: SignatureService,
  dataDir: string,
): void {
  registry.registerHandle('pdf:font-covers-text', (_event, font: unknown, text: unknown) => {
    const bytes = asBytes(font)
    if (!bytes || typeof text !== 'string') {
      throw new Error('pdf:font-covers-text expects font bytes and text')
    }
    return fontCoversText(Buffer.from(bytes), text)
  })
  registry.registerHandle('pdf:subset-font', async (_event, font: unknown, text: unknown) => {
    const bytes = asBytes(font)
    if (!bytes || typeof text !== 'string') {
      throw new Error('pdf:subset-font expects font bytes and text')
    }
    return new Uint8Array(await subsetTtf(Buffer.from(bytes), text))
  })
  // Saved signatures are desktop userData state; on the Web they belong to the
  // server's data root so a browser tab keeps them across reloads.
  registry.registerHandle('pdf:list-signatures', () => signatures.list())
  registry.registerHandle('pdf:add-signature', (_event, data: unknown) => {
    if (!isSignatureData(data)) throw new Error('pdf:add-signature expects signature data')
    return signatures.add(data)
  })
  registry.registerHandle('pdf:remove-signature', (_event, id: unknown) => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error('pdf:remove-signature expects an id')
    }
    return signatures.remove(id)
  })
  // Export naming: the renderer needs the non-colliding target before it streams
  // the bytes back for download.
  registry.registerHandle('pdf:generated-output-path', (_event, name: unknown) => {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('pdf:generated-output-path expects a source name')
    }
    return uniqueGeneratedPdfPath(dataDir, name)
  })
}

/**
 * Slides rendering/font capabilities that need no Electron: the bundled font
 * catalog and the sniffers that decide how an archive part renders.
 */
function registerSlidesRenderHandlers(registry: IpcHandlerRegistry): void {
  registry.registerHandle('slides:font-catalog', () => FONT_CATALOG)
  registry.registerHandle('slides:media-mime', (_event, mediaRef: unknown, bytes: unknown) => {
    const value = asBytes(bytes)
    if (typeof mediaRef !== 'string' || !value) {
      throw new Error('slides:media-mime expects a media reference and bytes')
    }
    return displayMime(mediaRef, value)
  })
  registry.registerHandle('slides:container-kind', (_event, bytes: unknown) => {
    const value = asBytes(bytes)
    if (!value) throw new Error('slides:container-kind expects bytes')
    return cfbKind(Buffer.from(value))
  })
  // Browsers cannot display TIFF, so the server transcodes it the same way the
  // desktop renderer does.
  registry.registerHandle('slides:tiff-to-png', (_event, bytes: unknown) => {
    const value = asBytes(bytes)
    if (!value) throw new Error('slides:tiff-to-png expects bytes')
    const decoded = tiffToPng(value)
    if (!decoded) return null
    return { ...decoded, png: new Uint8Array(decoded.png) }
  })
  // EXIF-rotated JPEGs are baked upright once, so every consumer sees one orientation.
  registry.registerHandle('slides:normalize-jpeg', (_event, bytes: unknown) => {
    const value = asBytes(bytes)
    if (!value) throw new Error('slides:normalize-jpeg expects bytes')
    return neutralizeJpegOrientation(value)
  })
  registry.registerHandle('slides:audio-support', (_event, bytes: unknown) => {
    const value = asBytes(bytes)
    if (!value) throw new Error('slides:audio-support expects bytes')
    return { formats: audioSampleFormats(value), unplayable: unplayableAudioCodec(value) }
  })
}

function registerDocxHandlers(registry: IpcHandlerRegistry, service: DocxFileService): void {
  registry.registerHandle('docs:read-path', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('docs:read-path expects a path')
    return service.read(path)
  })
  registry.registerHandle('docs:validate-path', async (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('docs:validate-path expects a path')
    return service.validate(await service.read(path))
  })
  registry.registerHandle('docs:save-bytes', async (_event, path: unknown, bytes: unknown) => {
    if (typeof path !== 'string' || !asBytes(bytes))
      throw new Error('docs:save-bytes expects path and bytes')
    return service.saveBytes(path, asBytes(bytes)!)
  })
  registry.registerHandle('docs:round-trip', async (_event, source: unknown, target: unknown) => {
    if (typeof source !== 'string' || typeof target !== 'string')
      throw new Error('docs:round-trip expects source and target paths')
    return service.roundTrip(source, target)
  })
}

export async function startWebServer(
  options: WebCompositionOptions = {},
): Promise<Awaited<ReturnType<typeof createWebComposition>>> {
  const composition = await createWebComposition(options)
  const shutdown = async () => composition.server.close()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  return composition
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  await startWebServer()
}
