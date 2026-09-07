/**
 * server/sse — Server-Sent Events transport for IPC push.
 *
 * Each renderer subscribes with a `?session=<id>` and receives events for
 * channels its handler invoked via `event.sender.send(...)`. Pending frames
 * are buffered (max 100) until the SSE handshake completes.
 */

import type { ServerResponse } from 'node:http'
import { encodeTransportValue } from '../common/registry.js'

export const sessionConnections = new Map<string, Set<ServerResponse>>()
export const PENDING_FRAMES = new Map<string, string[]>()
export const SSE_HEARTBEAT_MS = 25000

export function pushSseEvent(session: string, channel: string, args: unknown[]): void {
  const encodedArgs = args.map(arg => encodeTransportValue(arg))
  const frame = `data: ${JSON.stringify({ channel, args: encodedArgs })}\n\n`
  const connections = sessionConnections.get(session)
  if (connections) {
    for (const response of connections) {
      try { response.write(frame) } catch {}
    }
  } else {
    const pending = PENDING_FRAMES.get(session) || []
    pending.push(frame)
    if (pending.length > 100) pending.shift()
    PENDING_FRAMES.set(session, pending)
  }
}
