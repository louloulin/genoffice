import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildBlankDocx } from '@genoffice/docx-engine'
import { createWebComposition } from '../src/main.js'

async function invoke(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return {
    status: response.status,
    body: (await response.json()) as { ok?: boolean; result?: any },
  }
}
async function cleanup(...dirs: string[]) {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
}

describe('standalone Web composition root', () => {
  it('serves Markdown, project, blank office files, and workbook bytes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'genoffice-web-server-'))
    const root = await mkdtemp(join(tmpdir(), 'genoffice-web-files-'))
    try {
      const composition = await createWebComposition({
        port: 0,
        dataDir,
        workbookBackend: {
          open: async () => ({}),
          readRange: async () => ({}),
          close: async () => {},
        },
      })
      const path = join(dataDir, 'web.md')
      expect(
        (await invoke(composition.server.port, 'markdown:write-file', [path, '# Web'])).status,
      ).toBe(200)
      expect(
        (await invoke(composition.server.port, 'markdown:read-file', [path])).body.result,
      ).toBe('# Web')
      expect(
        (await invoke(composition.server.port, 'project:create', [{ name: 'Web project' }])).body
          .result.name,
      ).toBe('Web project')
      expect((await invoke(composition.server.port, 'slides:create-blank', [])).status).toBe(200)
      expect((await invoke(composition.server.port, 'pdf:create-blank', [])).status).toBe(200)
      const workbookPath = join(dataDir, 'book.xlsx')
      await writeFile(workbookPath, Buffer.from([1, 2, 3]))
      expect(
        (await invoke(composition.server.port, 'workbook:read-file', [workbookPath])).status,
      ).toBe(200)
      await composition.server.close()
    } finally {
      await cleanup(dataDir, root)
    }
  })

  it('serves successful office, workbook, and AI operations', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'genoffice-web-server-'))
    const root = await mkdtemp(join(tmpdir(), 'genoffice-web-office-'))
    try {
      const composition = await createWebComposition({
        port: 0,
        dataDir,
        workbookBackend: {
          open: async () => ({ sessionId: 'web-session' }),
          readRange: async () => ({ values: [['ok']] }),
          close: async () => {},
        },
        aiService: {
          chat: async () => ({ ok: true, content: 'hello' }),
          search: async () => ({ results: [], method: 'test' }),
        },
      })
      const slidesPath = join(dataDir, 'deck.pptx')
      const slides = (await invoke(composition.server.port, 'slides:create-blank', [])).body.result
      expect(
        (await invoke(composition.server.port, 'slides:save-file', [slidesPath, slides])).status,
      ).toBe(200)
      expect((await invoke(composition.server.port, 'slides:read-file', [slidesPath])).status).toBe(
        200,
      )
      const pdf = (await invoke(composition.server.port, 'pdf:create-blank', [])).body.result
      const pdfPath = join(dataDir, 'blank.pdf')
      expect((await invoke(composition.server.port, 'pdf:save-file', [pdfPath, pdf])).status).toBe(
        200,
      )
      expect((await invoke(composition.server.port, 'pdf:read-file', [pdfPath])).status).toBe(200)
      expect(
        (await invoke(composition.server.port, 'workbook:open', [slidesPath])).body.result
          .sessionId,
      ).toBe('web-session')
      expect(
        (
          await invoke(composition.server.port, 'workbook:read-range', [
            { sessionId: 'web-session' },
          ])
        ).body.result.values[0][0],
      ).toBe('ok')
      expect(
        (await invoke(composition.server.port, 'workbook:close', ['web-session'])).status,
      ).toBe(200)
      expect(
        (await invoke(composition.server.port, 'ai:web-search', ['query'])).body.result.method,
      ).toBe('test')
      expect(
        (
          await invoke(composition.server.port, 'ai:chat', [
            {
              settings: { provider: 'custom', providers: { custom: { apiKey: '', model: '' } } },
              system: '',
              user: '',
            },
          ])
        ).body.result.content,
      ).toBe('hello')
      await composition.server.close()
    } finally {
      await cleanup(dataDir, root)
    }
  })

  it('validates and saves DOCX bytes through HTTP', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'genoffice-web-server-'))
    const root = await mkdtemp(join(tmpdir(), 'genoffice-web-docs-'))
    try {
      const composition = await createWebComposition({ port: 0, dataDir })
      const validPath = join(dataDir, 'valid.docx')
      await writeFile(validPath, await buildBlankDocx())
      expect(
        (await invoke(composition.server.port, 'docs:validate-path', [validPath])).status,
      ).toBe(200)
      const savedPath = join(dataDir, 'saved.docx')
      const bytes = (await invoke(composition.server.port, 'docs:read-path', [validPath])).body
        .result
      expect(
        (await invoke(composition.server.port, 'docs:save-bytes', [savedPath, bytes])).status,
      ).toBe(200)
      expect(
        (await invoke(composition.server.port, 'docs:validate-path', [savedPath])).status,
      ).toBe(200)
      await composition.server.close()
    } finally {
      await cleanup(dataDir, root)
    }
  })
})
