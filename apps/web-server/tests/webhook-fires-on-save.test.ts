/**
 * Webhook integration — verify that every save path fires `file.saved` to
 * registered callbacks via `notifyFileSaved`.
 *
 * The webhooks-store keeps an in-memory cache of subscriptions, so each
 * test uses a unique `fileId` to stay isolated from siblings.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'

/* This suite drives the real `notifyFileSaved`, and the "target is down" case
 * pushes a dead letter. Without an isolated DATA_DIR that entry landed in the
 * shared default (`/tmp/genoffice-data`) and was then hydrated by
 * `webhooks-dlq.test.ts`, which asserts its store holds exactly the entries it
 * created — so this file's leftovers broke that one at random.
 *
 * `vi.hoisted` is required, not cosmetic: Vitest hoists `import` above the
 * module body, so `common/state.ts` resolves DATA_DIR before any module-body
 * assignment could run. */
const RESTORE = vi.hoisted(() => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-fires-on-save-'))
  const KEYS = ['DATA_DIR', 'GENOFFICE_DATA_DIR', 'GENOFFICE_WEB_DATA_DIR'] as const
  const restore = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  process.env.DATA_DIR = dir
  process.env.GENOFFICE_DATA_DIR = dir
  process.env.GENOFFICE_WEB_DATA_DIR = dir
  return restore as Record<string, string | undefined>
})

afterAll(() => {
  for (const [k, v] of Object.entries(RESTORE)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

import { saveCallback, deleteCallback, notifyFileSaved } from '../src/common/webhooks-store'

let server: Server | null = null
let url = ''
const received: { body: unknown; headers: Record<string, string> }[] = []

async function start(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        try {
          received.push({ body: body ? JSON.parse(body) : null, headers: { 'content-type': req.headers['content-type'] ?? '' } })
        } catch {
          received.push({ body, headers: { 'content-type': req.headers['content-type'] ?? '' } })
        }
        res.writeHead(204)
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        url = `http://127.0.0.1:${addr.port}`
      }
      resolve()
    })
  })
}

async function stop(): Promise<void> {
  if (!server) return
  await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
}

beforeEach(async () => {
  received.length = 0
  await start()
})

afterEach(async () => {
  await stop()
})

describe('notifyFileSaved', () => {
  it('fires a file.saved envelope with path + format when a callback is registered for the basename', async () => {
    const id = 'demo-doc.docx'
    saveCallback({ fileId: id, url: `${url}/hook`, events: ['file.saved'], createdAt: Date.now() })

    notifyFileSaved(`/managed/path/${id}`, { size: 1234, format: 'docx' })

    // Wait for fetch delivery (best-effort, fire-and-forget).
    await new Promise((r) => setTimeout(r, 200))
    expect(received.length).toBe(1)
    expect(received[0]!.body).toMatchObject({
      v: '1.0',
      event: 'file.saved',
      fileId: id,
      data: {
        path: `/managed/path/${id}`,
        size: 1234,
        format: 'docx',
      },
    })
    expect(received[0]!.headers['content-type']).toMatch(/application\/json/)

    deleteCallback(id)
  })

  it('does nothing when no callback is registered', async () => {
    notifyFileSaved('/managed/path/no-listener.xlsx', { format: 'xlsx' })
    await new Promise((r) => setTimeout(r, 150))
    expect(received.length).toBe(0)
  })

  it('skips events not in the subscriber allowlist', async () => {
    const id = 'only-create.md'
    saveCallback({ fileId: id, url: `${url}/hook`, events: ['file.created'], createdAt: Date.now() })

    notifyFileSaved(`/managed/path/${id}`, { format: 'md' })
    await new Promise((r) => setTimeout(r, 150))
    expect(received.length).toBe(0)

    deleteCallback(id)
  })

  it('does not throw when the webhook target is down', async () => {
    const id = 'unreachable.docx'
    saveCallback({ fileId: id, url: 'http://127.0.0.1:1/hook', events: ['file.saved'], createdAt: Date.now() })

    expect(() => notifyFileSaved(`/managed/path/${id}`, { format: 'docx' })).not.toThrow()
    await new Promise((r) => setTimeout(r, 200))
    expect(received.length).toBe(0)

    deleteCallback(id)
  })

  it('handles windows-style paths by extracting the basename', async () => {
    const id = 'windows-path.docx'
    saveCallback({ fileId: id, url: `${url}/hook`, events: ['file.saved'], createdAt: Date.now() })

    notifyFileSaved(`C:\\Users\\demo\\Documents\\${id}`, { format: 'docx' })
    await new Promise((r) => setTimeout(r, 200))
    expect(received.length).toBe(1)
    expect(received[0]!.body).toMatchObject({ fileId: id })

    deleteCallback(id)
  })
})
