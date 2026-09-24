/**
 * HTTP utilities for the REST API v1 surface. Inline implementations so
 * the v1 module doesn't depend on private helpers from `apps/web-server/src/index.ts`
 * (which is the bundle entry — internal symbols there are not exported and
 * trying to import them pulls the whole server into the v1 dep graph).
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBodyWithCap, MAX_HTTP_BODY_BYTES } from '../../common/read-body'
import { classifyWebError } from '../../ai/errors'

/**
 * Read the request body as a UTF-8 string. Caps at MAX_HTTP_BODY_BYTES (default 4 MB) to refuse oversized payloads.
 */
export async function readBody(request: IncomingMessage): Promise<string> {
  return readBodyWithCap(request, MAX_HTTP_BODY_BYTES)
}

/**
 * Write a JSON response with `Content-Type: application/json` and `Cache-Control: no-store`.
 */
export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

/**
 * Standard error envelope used by every v1 endpoint. Same shape as the
 * existing IPC error envelope so a client can share one error handler.
 */
export function sendError(
  response: ServerResponse,
  status: number,
  message: string,
  code = 'ERROR',
  channel?: string,
): void {
  sendJson(response, status, {
    error: {
      message,
      code,
      ...(channel ? { channel } : {}),
    },
  })
}

/**
 * Bridge a thrown error (typically from a handler that already throws
 * InvalidArgumentError / NotFoundError / WebUnsupportedError) into the
 * standard v1 envelope. Falls back to 500 on unknown error shapes.
 */
export function sendIpcError(
  response: ServerResponse,
  error: unknown,
  _fatal: boolean,
  channel: string,
): void {
  const classified = classifyWebError(error, channel)
  const status = (classified as { status?: number }).status ?? 500
  const message = classified.message
  const code = (classified as { code?: string }).code ?? 'INTERNAL'
  sendError(response, status, message, code, channel)
}

/**
 * Validate a webhook subscription URL.
 *
 * Accepts only `http:` and `https:` schemes — anything else (`file:`,
 * `javascript:`, `data:`, `ftp:`, custom schemes, malformed URLs,
 * non-strings) returns false. The web-server fires webhooks via
 * `fetch()` which only knows HTTP(S), so accepting a `file:` URL
 * silently produces a registered-but-never-fired subscription —
 * exactly the §11.117 "silent webhook failure" class.
 *
 * Note: this does NOT block private/loopback addresses (127.0.0.1,
 * 169.254.x.x, 10.x.x.x, etc.). Hosts routinely register webhooks
 * pointing at dev/staging receivers; SSRF mitigation is a separate,
 * host-level concern (deploy behind a proxy that filters egress).
 */
export function isValidWebhookUrl(url: unknown): url is string {
  if (typeof url !== 'string' || url.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:'
}

/**
 * Validate an event whitelist for a webhook subscription.
 *
 * Returns:
 *   - `true` when `events` is an array of non-empty strings (an
 *     empty array is accepted — existing convention means "all
 *     events", preserved for back-compat with the §11.93 user-wide
 *     shape that registers `events: []` to opt into everything).
 *   - `false` when `events` is a non-array, or any element is not a
 *     non-empty string.
 *
 * `null` and `undefined` are NOT validated here — callers should
 * treat those as "events omitted, use default" per §11.115 semantics
 * (a JSON `null` from a serializer is "unset", not "explicit empty").
 */
export function isValidEventList(events: unknown): events is string[] {
  if (!Array.isArray(events)) return false
  for (const e of events) {
    if (typeof e !== 'string' || e.length === 0) return false
  }
  return true
}

/**
 * Validate a comment anchor.
 *
 * Accepts only a plain object (`Record<string, unknown>`):
 *   - `typeof === 'object'` filters primitives (string, number, boolean)
 *   - `!Array.isArray(...)` filters arrays — `typeof [] === 'object'`
 *     but a comment anchor is conceptually a location descriptor
 *     (`{ range, cell, slideId, ... }`), never an indexed sequence.
 *     Storing an array would break downstream renderer code that
 *     accesses named properties (`anchor.range`, `anchor.cell`,
 *     `anchor.slideId`) and would silently produce UI that cannot
 *     resolve the comment's location.
 *   - non-null filters JSON `null` (the §11.115/§11.116/§11.117
 *     convention: "not provided" stays valid, but "explicit null" for a
 *     required object field is caller error).
 *
 * Note: this does NOT validate the inner shape — `range` / `cell` /
 * `slideId` are app-specific. The CommentAnchor contract is
 * intentionally open (`[key: string]: unknown`) so new apps can add
 * fields without a schema bump. The store validates only that the
 * outer shape is an object.
 */
export function isPlainAnchor(anchor: unknown): anchor is Record<string, unknown> {
  if (anchor === null || anchor === undefined) return false
  if (typeof anchor !== 'object') return false
  if (Array.isArray(anchor)) return false
  return true
}
