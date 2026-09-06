import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'

export interface MarkdownFileServiceOptions {
  /** Optional allow-list root. Omit for a trusted local server. */
  rootDir?: string
}

export interface MarkdownProjectHandlers {
  readFile(path: string): Promise<string>
  writeFile(path: string, content: string): Promise<void>
  listProjects(): unknown
  createProject(name: string): unknown
}

/** Register the small, Node-safe Markdown/project HTTP surface. */
export function registerMarkdownProjectHandlers(
  registry: {
    registerHandle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void
  },
  handlers: MarkdownProjectHandlers,
): void {
  registry.registerHandle('markdown:read-file', (_event, path: unknown) => {
    if (typeof path !== 'string') throw new Error('markdown:read-file expects a path')
    return handlers.readFile(path)
  })
  registry.registerHandle('markdown:write-file', (_event, path: unknown, content: unknown) => {
    if (typeof path !== 'string' || typeof content !== 'string') {
      throw new Error('markdown:write-file expects path and content')
    }
    return handlers.writeFile(path, content)
  })
  registry.registerHandle('project:list', () => handlers.listProjects())
  registry.registerHandle('project:create', (_event, args: unknown) => {
    const name =
      args && typeof args === 'object' && 'name' in args
        ? (args as { name?: unknown }).name
        : undefined
    if (typeof name !== 'string') throw new Error('project:create expects { name }')
    return handlers.createProject(name)
  })
}

/** Node-only Markdown file operations used by the standalone Web composition root. */
export class MarkdownFileService {
  private readonly rootDir?: string

  constructor(options: MarkdownFileServiceOptions = {}) {
    this.rootDir = options.rootDir ? resolve(options.rootDir) : undefined
  }

  async read(filePath: string): Promise<string> {
    const path = this.resolveAllowed(filePath)
    return readFile(path, 'utf8')
  }

  async write(filePath: string, content: string): Promise<void> {
    const path = this.resolveAllowed(filePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  private resolveAllowed(filePath: string): string {
    if (!filePath || typeof filePath !== 'string') throw new Error('markdown file path is required')
    const path = resolve(filePath)
    if (this.rootDir && path !== this.rootDir && !path.startsWith(`${this.rootDir}/`)) {
      throw new Error('markdown file path is outside the configured root')
    }
    return path
  }
}
