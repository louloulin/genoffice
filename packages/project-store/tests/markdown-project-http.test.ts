import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStandaloneWebServer } from '@genoffice/ipc-bridge'
import { ProjectStore } from '../src/store.js'
import {
  MarkdownFileService,
  registerMarkdownProjectHandlers,
} from '../src/markdown-file-service.js'

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('standalone Markdown/project HTTP handlers', () => {
  it('serves Markdown read/write and project operations without Electron', async () => {
    const root = await mkdtemp(join(tmpdir(), 'genoffice-markdown-http-'))
    roots.push(root)
    const fileService = new MarkdownFileService({ rootDir: root })
    const projectStore = new ProjectStore(root)
    const { server, registry } = await createStandaloneWebServer({ port: 0 })
    registerMarkdownProjectHandlers(registry, {
      readFile: (path) => fileService.read(path),
      writeFile: (path, content) => fileService.write(path, content),
      listProjects: () => projectStore.listProjectsSummary(),
      createProject: (name) => projectStore.createProject(name),
    })
    const url = `http://127.0.0.1:${server.port}/api/ipc/`
    const path = join(root, 'notes.md')
    const write = await fetch(`${url}markdown%3Awrite-file`, {
      method: 'POST',
      body: JSON.stringify({ args: [path, '# HTTP'] }),
    })
    expect(write.status).toBe(200)
    const read = await fetch(`${url}markdown%3Aread-file`, {
      method: 'POST',
      body: JSON.stringify({ args: [path] }),
    })
    expect(read.status).toBe(200)
    expect((await read.json()).result).toBe('# HTTP')

    const created = await fetch(`${url}project%3Acreate`, {
      method: 'POST',
      body: JSON.stringify({ args: [{ name: 'HTTP project' }] }),
    })
    expect(created.status).toBe(200)
    expect((await created.json()).result.name).toBe('HTTP project')
    await server.close()
  })
})
