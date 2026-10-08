/**
 * Body reader with a hard byte cap (mirrors apps/web-server/src/common/read-body).
 * We do NOT destroy the request on breach: tearing down the stream resets the
 * socket instead of yielding a clean 413.
 */
import type { IncomingMessage } from 'node:http'

export class RequestBodyTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE' as const
  readonly httpStatus = 413 as const
  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`)
    this.name = 'RequestBodyTooLargeError'
  }
}

export class RequestBodyAbortedError extends Error {
  readonly code = 'CLIENT_ABORTED' as const
  readonly httpStatus = 400 as const
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RequestBodyAbortedError'
  }
}

export async function readBodyWithCap(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        chunks.length = 0
        reject(new RequestBodyTooLargeError(maxBytes))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (aborted) return
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    request.on('error', (err) => {
      if (aborted) return
      aborted = true
      chunks.length = 0
      reject(new RequestBodyAbortedError(err))
    })
  })
}

export const MAX_HTTP_BODY_BYTES = 200 * 1024 * 1024