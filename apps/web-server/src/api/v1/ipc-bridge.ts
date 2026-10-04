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

/**
 * `eventOverrides` lets a v1 handler carry what the HTTP `/api/ipc` dispatcher
 * threads on its own synthesized event — above all `userId`, the verified JWT
 * subject. Without it, every REST-invoked handler sees a userId-less event and
 * embed-vs-local decisions (`settings-sanitize.ts` `isEmbedCaller`) degrade to
 * "local", letting a JWT caller's injected `apiKey`/`baseUrl` through as if it
 * were operator BYOK.
 *
 * `tenantId` (A40) rides the same path: handlers that write audit records
 * read it off the event so a guest JWT's tenant lands on its records instead
 * of the 'default' bucket.
 */
export async function invokeIpc(
  channel: string,
  args: unknown[],
  eventOverrides?: { userId?: string; tenantId?: string; auditEndpoint?: string },
): Promise<unknown> {
  const handler = getHandler(channel)
  if (!handler) {
    throw new Error(`No IPC handler for '${channel}'`)
  }
  const event = {
    processId: 0,
    frameId: 0,
    sender: senderStub,
    ...eventOverrides,
  }
  return await handler(event, ...args)
}
