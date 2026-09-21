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
