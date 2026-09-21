/**
 * In-process IPC bridge for REST API v1 handlers.
 *
 * Most v1 endpoints forward to existing IPC handlers rather than re-implement
 * the same logic. The bridge mimics the dispatch shape the HTTP `/api/ipc/:channel`
 * route uses — `getHandler(channel)(event, ...args)` — so behaviour is identical.
 *
 * Avoids HTTP self-call latency and the JSON re-serialisation tax. Errors
 * propagate as thrown Error instances; the v1 handler maps them to HTTP
 * status codes via `classifyWebError` in `http-utils.ts`.
 */
import { getHandler } from '../../common/index'

const senderStub = {
  id: -1,
  isDestroyed: () => false,
  send: () => {
    /* REST handlers don't open SSE back-channels; send() is a no-op. */
  },
}

export async function invokeIpc(channel: string, args: unknown[]): Promise<unknown> {
  const handler = getHandler(channel)
  if (!handler) {
    throw new Error(`No IPC handler for '${channel}'`)
  }
  const event = {
    processId: 0,
    frameId: 0,
    sender: senderStub,
  }
  return await handler(event, ...args)
}
