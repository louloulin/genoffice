/**
 * Regression tests for `ai:save-translation-memory` shape validation.
 *
 * The handler stores translation memory entries through `saveMany`, whose
 * `keyOf` builds the cache key as `${sourceLang}::${targetLang}::${source}::${bucket}`.
 * `bucket` arrives straight off the wire and is therefore typed as any. The
 * original implementation let a number or array fall through, which then
 * crashed inside `keyOf` with `bucket.trim is not a function`. The handler
 * now guards every field that can become the bucket before the value reaches
 * the persistence layer.
 *
 * Keeping these as a separate file from the broader malformed-payloads
 * suite means a regression in the bucket guard surfaces in isolation,
 * without the noise of the SSE / units / glossaryCategory coverage that
 * lives next door.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'
import { join } from 'node:path'
import { request } from 'node:http'

const PORT = 18930 + Math.floor(Math.random() * 100)
const TMP_DATA = mkdtempSync(join(tmpdir(), 'genoffice-save-memory-shape-'))
const BUNDLE = join(__dirname, '..', 'dist', 'bundle', 'index.js')

let server: ChildProcessWithoutNullStreams | null = null

interface IpcEnvelope {
  ok: boolean
  result?: { ok: boolean; error?: string; skippedCount?: number; savedCount?: number }
  error?: { code?: string; message?: string }
}

function ipc(channel: string, args: unknown[]): Promise<{ status: number; body: IpcEnvelope }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ args })
    const req = request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: `/api/ipc/${channel}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-IPC-Session': 'save-memory-shape',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as IpcEnvelope,
          }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

beforeAll(async () => {
  server = spawn(process.execPath, [BUNDLE], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      DATA_DIR: TMP_DATA,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolve) => {
    const onChunk = (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('Agent Loop SSE')) {
        server!.stdout.off('data', onChunk)
        resolve()
      }
    }
    server!.stdout.on('data', onChunk)
  })
}, 60_000)

afterAll(async () => {
  await stopServer(server, TMP_DATA)
  server = null
})

describe('ai:save-translation-memory — bucket shape', () => {
  it('rejects a non-string bucket', async () => {
    // `bucket ?? glossaryCategory ?? customerName` reaches `saveMany` via the
    // raw value when the caller forgets the field is typed. Numbers and
    // arrays used to slip through; `keyOf` then crashed on `.trim()`. The
    // handler now refuses each branch up front.
    const bad: unknown[] = [42, 7.5, true, { x: 1 }, ['array'], null]
    for (const value of bad) {
      const res = await ipc('ai:save-translation-memory', [
        {
          sourceLang: 'en-US',
          targetLang: 'zh-CN',
          bucket: value,
          units: [{ unitId: 'ok', sourceText: 'Hi', translatedText: '你好' }],
        },
      ])
      expect(res.status, `bucket=${JSON.stringify(value)}`).toBe(200)
      expect(res.body.result?.ok).toBe(false)
      expect(res.body.result?.error).toMatch(/bucket must be a string/i)
    }
  })

  it('rejects a non-string customerName even when bucket is absent', async () => {
    // The `req.bucket ?? req.glossaryCategory ?? req.customerName` chain picks
    // `customerName` when the others are missing, so the guard has to cover
    // it as well.
    const res = await ipc('ai:save-translation-memory', [
      {
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        customerName: 42,
        units: [{ unitId: 'ok', sourceText: 'Hi', translatedText: '你好' }],
      },
    ])
    expect(res.status).toBe(200)
    expect(res.body.result?.ok).toBe(false)
    expect(res.body.result?.error).toMatch(/customerName must be a string/i)
  })

  it('accepts a well-shaped bucket and reports the saved count', async () => {
    const res = await ipc('ai:save-translation-memory', [
      {
        sourceLang: 'en-US',
        targetLang: 'zh-CN',
        bucket: 'ACME',
        units: [{ unitId: 'ok', sourceText: 'Hi', translatedText: '你好' }],
      },
    ])
    expect(res.status).toBe(200)
    expect(res.body.result?.ok).toBe(true)
    expect(res.body.result?.savedCount).toBe(1)
  })
})
