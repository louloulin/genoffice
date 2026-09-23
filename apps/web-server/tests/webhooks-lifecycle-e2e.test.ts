/**
 * End-to-end lifecycle for the v1 webhooks + DLQ + callbacks surface
 * (sdk1.md §11.33 + §11.93 + §11.94).
 *
 * Walks the full happy path plus the negative branches that were easy
 * to skip in §11.95's shallow smoke:
 *
 *   - POST   /api/v1/webhooks          register subscription (webhooks:manage)
 *   - GET    /api/v1/webhooks/dlq      DLQ list (webhooks:manage)
 *   - POST   /api/v1/callbacks         admin-only fire (admin)
 *   - DELETE /api/v1/webhooks          unsubscribe + purge DLQ (webhooks:manage)
 *   - DELETE /api/v1/webhooks          idempotent no-op on already-removed
 *
 * Plus auth / scope-gate / input-validation contracts:
 *   - 401 on missing JWT
 *   - 403 on missing webhooks:manage (POST / DELETE)
 *   - 403 on missing admin (callbacks:fire)
 *   - 400 on missing url / event / fileId
 *   - 404 on unknown /api/v1/webhooks/dlq/:id entry
 *
 * The receiver is a tiny in-test HTTP server on a random port that
 * records POST bodies. Successful receives + DLQ entries are
 * inspectable from inside the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness, SmokeRecorder } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface ReceivedEvent {
  path: string
  body: string
  headers: Record<string, string | string[] | undefined>
}

async function startReceiver(port = 0): Promise<{ server: Server; port: number; events: ReceivedEvent[]; status: number }> {
  const state = {
    server: null as unknown as Server,
    port: 0,
    events: [] as ReceivedEvent[],
    status: 200,
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      state.events.push({
        path: req.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      })
      res.statusCode = state.status
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  const addr = server.address()
  state.port = typeof addr === 'object' && addr ? addr.port : 0
  state.server = server
  return state
}

async function stopReceiver(state: { server: Server }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    state.server.close((err) => (err ? reject(err) : resolve())),
  )
}

describe.skipIf(skip)('v1 webhooks + DLQ + callbacks lifecycle', () => {
  let receiver: Awaited<ReturnType<typeof startReceiver>> | null = null

  beforeEach(() => {
    receiver = null
  })

  afterEach(async () => {
    if (receiver) {
      await stopReceiver(receiver)
      receiver = null
    }
  })

  it('walks subscribe → fire → DLQ on failure → unsubscribe + purge', async () => {
    const h = await ServerHarness.start()
    const rec = new SmokeRecorder()
    const adminToken = await h.token('webhook-tester', [
      'files:read',
      'files:write',
      'webhooks:manage',
      'admin',
    ])
    const readerOnlyToken = await h.token('reader-only', ['files:read'])
    const headers = { 'content-type': 'application/json' }
    const authPost = { token: adminToken, method: 'POST' as const, headers }
    const authGet = { token: adminToken }
    const authDel = { token: adminToken, method: 'DELETE' as const }

    try {
      // Start a receiver that will FAIL with 500 so every fire pushes
      // a DLQ entry (the bundle retries 3x with exponential backoff,
      // then drops the dead letter in the DLQ).
      receiver = await startReceiver()
      receiver.status = 500
      const url = `http://127.0.0.1:${receiver.port}/hook`

      // ── 1. Subscribe ──────────────────────────────────────────────────────
      {
        const r = await h.req<{ ok: boolean; subscriber: string; url: string }>('/api/v1/webhooks', {
          ...authPost,
          body: JSON.stringify({ url, events: ['file.saved', 'comment.added'] }),
        })
        rec.record('POST /api/v1/webhooks → 201 + subscriber + url', r.status === 201 && r.body.ok === true && r.body.url === url, `sub=${r.body.subscriber ?? '?'}`)
      }

      // ── 2. Fire (admin callbacks:fire) — receiver returns 500 ─────────────
      {
        const r = await h.req<{ ok: boolean; fired: string; deliveredCount: number }>('/api/v1/callbacks', {
          ...authPost,
          body: JSON.stringify({ event: 'file.saved', fileId: 'lifecycle-doc-1', data: { source: 'lifecycle' } }),
        })
        rec.record('POST /api/v1/callbacks (admin fire) → 200 + fired + deliveredCount:0', r.status === 200 && r.body.ok === true && r.body.fired === 'file.saved' && r.body.deliveredCount === 0, `fired=${r.body.fired ?? '?'}`)
      }

      // Wait for the bundle's retry chain to settle (3 attempts, up to
      // ~1s of jittered backoff; receiver responds 500 instantly).
      await new Promise((res) => setTimeout(res, 2500))

      // ── 3. DLQ should now have ≥1 entry for our URL ────────────────────────
      let dlqId = ''
      {
        const r = await h.req<{ count: number; entries: { id: string; url: string; event: string; status: number }[] }>(
          '/api/v1/webhooks/dlq',
          authGet,
        )
        const match = r.body.entries?.find((e) => e.url === url)
        rec.record('GET /api/v1/webhooks/dlq has entry for our URL', r.status === 200 && (r.body.count ?? 0) >= 1 && !!match, `count=${r.body.count} match=${match?.id ?? 'none'}`)
        dlqId = match?.id ?? ''
      }

      // ── 4. Get single DLQ entry ──────────────────────────────────────────
      if (dlqId) {
        const r = await h.req(`/api/v1/webhooks/dlq/${dlqId}`, authGet)
        rec.record('GET /api/v1/webhooks/dlq/:id → 200', r.status === 200, `status=${r.status}`)
      } else {
        rec.record('GET /api/v1/webhooks/dlq/:id → 200', false, 'no dlqId (skipped)')
      }

      // ── 5. Unknown DLQ id → 404 ───────────────────────────────────────────
      {
        const r = await h.req('/api/v1/webhooks/dlq/dlq_does_not_exist', authGet)
        rec.record('GET unknown DLQ entry → 404', r.status === 404, `status=${r.status}`)
      }

      // ── 6. Unsubscribe — must also purge DLQ for our URL (sdk1 §11.94) ───
      {
        const r = await h.req<{ ok: boolean; removed: boolean; dlqPurged: { removed: number; ids: string[] } }>(
          '/api/v1/webhooks',
          authDel,
        )
        const purgedCount = r.body.dlqPurged?.removed ?? 0
        rec.record('DELETE /api/v1/webhooks → 200 + removed:true + dlqPurged.removed > 0', r.status === 200 && r.body.removed === true && purgedCount >= 1, `purged=${purgedCount}`)
      }

      // ── 7. Second DELETE is idempotent no-op (removed:false, purge 0) ─────
      {
        const r = await h.req<{ ok: boolean; removed: boolean; dlqPurged: { removed: number; ids: string[] } }>(
          '/api/v1/webhooks',
          authDel,
        )
        rec.record('DELETE /api/v1/webhooks idempotent → removed:false + dlqPurged.removed:0', r.status === 200 && r.body.removed === false && r.body.dlqPurged.removed === 0, `removed=${r.body.removed} purged=${r.body.dlqPurged.removed}`)
      }

      // ── NEGATIVE: missing JWT ────────────────────────────────────────────
      {
        const r = await h.req('/api/v1/webhooks', { method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:1/x' }) })
        rec.record('No JWT → 401', r.status === 401, `status=${r.status}`)
      }

      // ── NEGATIVE: missing webhooks:manage on POST ────────────────────────
      {
        const r = await h.req('/api/v1/webhooks', { token: readerOnlyToken, method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:1/x' }) })
        rec.record('files:read-only on POST /webhooks → 403', r.status === 403, `status=${r.status}`)
      }

      // ── NEGATIVE: missing webhooks:manage on DELETE ──────────────────────
      {
        const r = await h.req('/api/v1/webhooks', { token: readerOnlyToken, method: 'DELETE' })
        rec.record('files:read-only on DELETE /webhooks → 403', r.status === 403, `status=${r.status}`)
      }

      // ── NEGATIVE: missing admin on callbacks:fire ────────────────────────
      {
        // First subscribe again so a fire attempt is meaningful
        await h.req('/api/v1/webhooks', { ...authPost, body: JSON.stringify({ url, events: ['file.saved'] }) })
        const r = await h.req('/api/v1/callbacks', { token: readerOnlyToken, method: 'POST', headers, body: JSON.stringify({ event: 'file.saved', fileId: 'x' }) })
        rec.record('files:read-only on callbacks:fire → 403', r.status === 403, `status=${r.status}`)
        // cleanup
        await h.req('/api/v1/webhooks', authDel)
      }

      // ── NEGATIVE: missing url on POST /webhooks ─────────────────────────
      {
        const r = await h.req('/api/v1/webhooks', { ...authPost, body: JSON.stringify({ events: ['file.saved'] }) })
        rec.record('Missing url on POST /webhooks → 400', r.status === 400, `status=${r.status}`)
      }

      // ── NEGATIVE: missing event on callbacks:fire ───────────────────────
      {
        const r = await h.req('/api/v1/callbacks', { ...authPost, body: JSON.stringify({ fileId: 'x' }) })
        rec.record('Missing event on callbacks:fire → 400', r.status === 400, `status=${r.status}`)
      }

      // ── NEGATIVE: missing fileId on callbacks:fire ──────────────────────
      {
        const r = await h.req('/api/v1/callbacks', { ...authPost, body: JSON.stringify({ event: 'file.saved' }) })
        rec.record('Missing fileId on callbacks:fire → 400', r.status === 400, `status=${r.status}`)
      }

      rec.printSummary()
      expect(rec.summary().ok).toBe(true)
    } finally {
      await h.stop()
    }
  }, 60_000)
})
