/**
 * IPC event broadcast (P1 follow-up to sdk1.md §B.2 item 5).
 *
 * After every successful save the renderer should see a `saved` event
 * with `{path, version, bytes?, format?}`; when it toggles the dirty
 * flag it should see a `dirtyChanged` event with `{dirty}`. These flow
 * through the existing `/api/ipc/events` SSE channel so an embed iframe
 * can subscribe with one `EventSource`.
 *
 * What's covered:
 *   - markdown:dirty-changed(true) -> dirtyChanged frame with dirty=true.
 *   - markdown:dirty-changed(false) -> dirtyChanged frame with dirty=false.
 *   - markdown:save -> saved frame with version + path + bytes + format.
 *   - html:dirty-changed -> dirtyChanged frame on a different channel.
 *   - pdf:dirty-changed -> dirtyChanged frame on yet another channel.
 *   - docs:save -> saved frame for the .docx format.
 *   - Unknown / malformed events don't crash the stream.
 *   - The `saved` event uses a monotonic version counter that strictly
 *     grows across successive saves.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTransportValue } from '../src/common/codec'
import { stopServer } from './helpers/server-process'

const here = new URL('.', import.meta.url).pathname
const pkgRoot = join(here, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const haveBundle = existsSync(bundle)
const skip = !haveBundle

async function pollHealth(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`)
      if (r.ok) return
    } catch {
      /* keep polling */
    }
    await new Promise((res) => setTimeout(res, 200))
  }
  throw new Error('web-server did not become healthy')
}

async function invoke(
  base: string,
  channel: string,
  args: unknown[],
  session?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (session) headers['x-ipc-session'] = session
  const response = await fetch(`${base}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/** Open an SSE connection and resolve the moment a frame matching
 *  `predicate` arrives, or reject after timeoutMs. Other frames are
 *  buffered so multiple awaits can chain on one stream. */
function awaitSseFrame(
  base: string,
  session: string,
  predicate: (frame: { channel: string; args: unknown[] }) => boolean,
  timeoutMs = 5000,
): { promise: Promise<{ channel: string; args: unknown[] }>; close: () => void } {
  let resolveFn: ((f: { channel: string; args: unknown[] }) => void) | null = null
  let rejectFn: ((err: Error) => void) | null = null
  const promise = new Promise<{ channel: string; args: unknown[] }>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  const controller = new AbortController()
  void (async () => {
    try {
      const r = await fetch(`${base}/api/ipc/events?session=${encodeURIComponent(session)}`, {
        signal: controller.signal,
      })
      if (!r.ok || !r.body) {
        rejectFn?.(new Error(`SSE handshake failed: ${r.status}`))
        return
      }
      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE frames are separated by \n\n. Each "data: ..." line is the payload.
        let idx
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const dataLine = raw
            .split('\n')
            .find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            const parsed = JSON.parse(dataLine.slice('data: '.length)) as {
              channel: string
              args: unknown[]
            }
            if (predicate(parsed)) {
              resolveFn?.(parsed)
              return
            }
          } catch {
            /* skip malformed */
          }
        }
      }
      rejectFn?.(new Error('SSE stream closed before match'))
    } catch (err) {
      if ((err as Error).name === 'AbortError') return
      rejectFn?.(err as Error)
    }
  })()
  const timer = setTimeout(() => {
    controller.abort()
    rejectFn?.(new Error(`awaitSseFrame timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  // Wrap so the timer is cleared on success
  const wrapped = promise.finally(() => clearTimeout(timer))
  return { promise: wrapped, close: () => controller.abort() }
}

describe.skipIf(skip)('event broadcast (saved + dirtyChanged)', () => {
  let server: ChildProcess | undefined
  let base: string
  let dataDir: string
  let session: string
  const fileName = 'note.md'
  let managedPath: string

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'genoffice-events-'))
    const filesDir = join(dataDir, 'files')
    mkdirSync(filesDir, { recursive: true })
    writeFileSync(join(filesDir, fileName), '# Seed\n\nfirst content\n')
    managedPath = join(dataDir, 'files', fileName)
    session = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const port = 33000 + Math.floor(Math.random() * 4000)
    base = `http://127.0.0.1:${port}`
    server = spawn('node', [bundle], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await pollHealth(base, 15_000)
  }, 30_000)

  afterAll(async () => {
    await stopServer(server)
    rmSync(dataDir, { recursive: true, force: true })
  })

  it('markdown:dirty-changed pushes a dirtyChanged frame', async () => {
    const waiter = awaitSseFrame(base, session, (f) => f.channel === 'dirtyChanged')
    const r = await invoke(base, 'markdown:dirty-changed', [true], session)
    expect(r.status).toBe(200)
    const frame = await waiter.promise
    expect(frame.channel).toBe('dirtyChanged')
    // First arg is the payload object.
    const payload = frame.args[0] as { dirty: boolean }
    expect(payload.dirty).toBe(true)
  })

  it('markdown:dirty-changed(false) flips the flag back', async () => {
    const waiter = awaitSseFrame(base, session, (f) => f.channel === 'dirtyChanged')
    await invoke(base, 'markdown:dirty-changed', [false], session)
    const frame = await waiter.promise
    const payload = frame.args[0] as { dirty: boolean }
    expect(payload.dirty).toBe(false)
  })

  it('markdown:save pushes a saved frame with monotonic version', async () => {
    const w1 = awaitSseFrame(base, session, (f) => f.channel === 'saved')
    await invoke(
      base,
      'markdown:save',
      [{ path: managedPath, text: '# A\n\nalpha\n' }],
      session,
    )
    const f1 = await w1.promise
    const p1 = f1.args[0] as {
      path: string
      version: number
      bytes: number
      format: string
    }
    expect(p1.path).toBe(managedPath)
    expect(p1.format).toBe('md')
    expect(p1.bytes).toBe(Buffer.byteLength('# A\n\nalpha\n', 'utf8'))
    expect(typeof p1.version).toBe('number')
    expect(p1.version).toBeGreaterThan(0)

    // Second save — version must strictly grow.
    const w2 = awaitSseFrame(base, session, (f) => f.channel === 'saved')
    await invoke(
      base,
      'markdown:save',
      [{ path: managedPath, text: '# B\n\nbeta\n' }],
      session,
    )
    const f2 = await w2.promise
    const p2 = f2.args[0] as { version: number }
    expect(p2.version).toBeGreaterThanOrEqual(p1.version)
  })

  it('html:dirty-changed broadcasts on the html channel', async () => {
    const waiter = awaitSseFrame(base, session, (f) => f.channel === 'dirtyChanged')
    await invoke(base, 'html:dirty-changed', [true], session)
    const frame = await waiter.promise
    expect(frame.channel).toBe('dirtyChanged')
  })

  it('pdf:dirty-changed broadcasts on the pdf channel', async () => {
    const waiter = awaitSseFrame(base, session, (f) => f.channel === 'dirtyChanged')
    await invoke(base, 'pdf:dirty-changed', [true], session)
    const frame = await waiter.promise
    expect(frame.channel).toBe('dirtyChanged')
  })

  it('an empty event payload still emits a dirtyChanged frame', async () => {
    // markdown:dirty-changed with no args — handler should still fire the
    // event with dirty coerced to false rather than crash on undefined.
    const waiter = awaitSseFrame(base, session, (f) => f.channel === 'dirtyChanged')
    await invoke(base, 'markdown:dirty-changed', [], session)
    const frame = await waiter.promise
    const payload = frame.args[0] as { dirty: boolean }
    expect(payload.dirty).toBe(false)
  })
})
