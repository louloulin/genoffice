/**
 * Read an HTTP request body as a UTF-8 string, enforcing a hard byte cap.
 *
 * The previous implementation concatenated every chunk unconditionally,
 * which meant a hostile client could pin the server by streaming an
 * unbounded body. Node's HTTP parser keeps producing `'data'` events
 * until the upstream socket closes; the only check the request pipeline
 * got was the per-channel cap inside `web:save-file`, but by then the
 * bytes were already in memory. Counting as we go lets us short-circuit
 * the moment the cap is breached: further chunks are discarded, the
 * accumulated buffers are released, and the caller sees a structured
 * error it can surface as 413. We do NOT call `request.destroy()` here
 * — destroying the request stream tears down the response on the same
 * socket, which turns the rejection into a connection reset rather than
 * a clean 413. The client will still finish uploading (the bytes drain
 * into the kernel-side socket buffer once Node stops reading them), and
 * we can write the 413 ourselves.
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

export async function readBodyWithCap(
  request: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let aborted = false
    request.on('data', (chunk: Buffer) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        // Release the accumulated buffers immediately so memory
        // pressure follows the cap, not the upload size.
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

/**
 * The single byte cap used by every IPC and translate endpoint. Set well
 * above the largest legitimate payload (`web:save-file` accepts up to
 * MAX_UPLOAD_BYTES = 100 MiB raw, which becomes ~134 MiB base64 inside
 * the JSON envelope) but small enough that a hostile client cannot pin
 * the server by streaming an unbounded body.
 */
export const MAX_HTTP_BODY_BYTES = 200 * 1024 * 1024
