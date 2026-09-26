/**
 * Shared test helpers for capability-client tests. Not part of the
 * public surface — keeps every test consistent and avoids drift.
 */

type HeaderInput = HeadersInit | undefined | null

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
  signal: AbortSignal | undefined
}

export interface MockResponseInit {
  status?: number
  headers?: Record<string, string>
  body?: unknown
  rawBody?: string
}

export interface MockFetch {
  fetchImpl: typeof fetch
  calls: CapturedRequest[]
}

export function makeMockFetch(
  handler: (req: CapturedRequest) => Response | Promise<Response>,
): MockFetch {
  const calls: CapturedRequest[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const req: CapturedRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: stringifyHeaders(init?.headers as HeaderInput),
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: (init?.signal as AbortSignal | undefined) ?? undefined,
    }
    calls.push(req)
    return handler(req)
  }
  return { fetchImpl, calls }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Wrap a handler's return value the way the web-server IPC dispatcher does.
 *
 * Every `/api/ipc/<channel>` request answers **200** with
 * `{ ok: true, result: <handler return> }` — the outer `ok` reports dispatch
 * success, and the handler's own verdict lives inside `result` (a handler
 * "failure" is `result: { ok: false, error: '…' }`). Use this for any mock
 * standing in for an IPC channel; a bare `jsonResponse(payload)` mocks a
 * contract the server never sends.
 */
export function ipcResponse(result: unknown): Response {
  return jsonResponse({ ok: true, result })
}

export function errorResponse(
  status: number,
  code: string,
  message: string,
  channel: string,
): Response {
  return jsonResponse({ error: { code, message, channel } }, status)
}

export function emptyResponse(status: number): Response {
  return new Response(null, { status })
}

function stringifyHeaders(h: HeaderInput): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (typeof (h as Headers).forEach === 'function' && !(h as Record<string, unknown>).entries) {
    ;(h as Headers).forEach((v, k) => (out[k.toLowerCase()] = v))
    return out
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v
    return out
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v
  return out
}
