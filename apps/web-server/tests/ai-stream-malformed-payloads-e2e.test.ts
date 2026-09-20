/**
 * Regression tests for POST /api/ai/stream and /api/ai/stream/cancel.
 *
 * The endpoint is the agent-loop SSE bridge that the docs/sheets/Slides
 * renderers hit. Two failure windows are exercised:
 *
 *   1. `JSON.parse` errors before `writeHead(200)`. The raw SyntaxError
 *      used to leak out as a 500 ("Unexpected token 'o', ..."), which
 *      looks like a server fault to the caller. It now resolves to a
 *      400 INVALID_ARGUMENT with the same `{error:{message,code,channel}}`
 *      shape the rest of the API uses.
 *
 *   2. `JSON.parse` errors in /api/ai/stream/cancel. Same problem on the
 *      cancel side; covered here so a future move of `readBody` cannot
 *      silently regress one endpoint without the other.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { stopServer } from './helpers/server-process'
import { join } from 'node:path'
import { request } from 'node:http'

const PORT = 18920 + Math.floor(Math.random() * 100)
const TMP_DATA = mkdtempSync(join(tmpdir(), 'genoffice-ai-stream-malformed-'))
const BUNDLE = join(__dirname, '..', 'dist', 'bundle', 'index.js')

let server: ChildProcessWithoutNullStreams | null = null

interface JsonError {
  error?: { message?: string; code?: string; channel?: string }
}

function postRaw(
  pathname: string,
  rawBody: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(rawBody)
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
  // Wait for the bundle to print its banner — that is when the HTTP listener
  // is up. Polling the port is faster but burns a few sockets; the log line
  // arrives in well under a second on every machine this has been tested on.
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

describe('POST /api/ai/stream — malformed body', () => {
  it('returns 400 INVALID_ARGUMENT instead of leaking the raw SyntaxError', async () => {
    const { status, body } = await postRaw('/api/ai/stream', 'not valid json')
    expect(status).toBe(400)
    const parsed = JSON.parse(body) as JsonError
    expect(parsed.error?.code).toBe('INVALID_ARGUMENT')
    expect(parsed.error?.channel).toBe('/api/ai/stream')
    expect(parsed.error?.message).toMatch(/not valid JSON/i)
    // The old behaviour surfaced `Unexpected token 'o', ...` which made it
    // look like the server itself had broken. Pin the regression.
    expect(parsed.error?.message).not.toMatch(/Unexpected token/)
  })

})

describe('POST /api/ai/stream/cancel — malformed body', () => {
  it('returns 400 INVALID_ARGUMENT instead of leaking the raw SyntaxError', async () => {
    const { status, body } = await postRaw('/api/ai/stream/cancel', '{this is not json')
    expect(status).toBe(400)
    const parsed = JSON.parse(body) as JsonError
    expect(parsed.error?.code).toBe('INVALID_ARGUMENT')
    expect(parsed.error?.channel).toBe('/api/ai/stream/cancel')
    expect(parsed.error?.message).not.toMatch(/Unexpected token/)
  })
})
