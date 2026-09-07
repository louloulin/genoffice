import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MarkdownFileService } from '../src/markdown-file-service.js'

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('MarkdownFileService', () => {
  it('writes and reads Markdown files without Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-markdown-service-'))
    roots.push(root)
    const service = new MarkdownFileService({ rootDir: root })
    const path = join(root, 'nested', 'notes.md')
    await service.write(path, '# Hello\n')
    expect(await service.read(path)).toBe('# Hello\n')
    expect(await readFile(path, 'utf8')).toBe('# Hello\n')
  })

  it('rejects paths outside the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-markdown-service-'))
    roots.push(root)
    const service = new MarkdownFileService({ rootDir: root })
    await expect(service.read(join(root, '..', 'outside.md'))).rejects.toThrow('outside')
  })
})
