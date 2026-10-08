/**
 * Per-host SSE hub — renderer tabs share one push channel per session id.
 * Mirrors the legacy plumbing in apps/web-server/src/index.ts (sessionConnections
 * + PENDING_FRAMES with a 60 s TTL, 25 s heartbeat) minus the multi-tenant parts.
 */
import type { ServerResponse } from 'node:http'
import { encodeTransportValue } from './codec'

const PENDING_FRAMES_TTL_MS = 60_000
const PENDING_FRAMES_MAX = 100

export class SseHub {
  private connections = new Map<string, Set<ServerResponse>>()
  private pending = new Map<string, string[]>()
  private touched = new Map<string, number>()
  private heartbeat: ReturnType<typeof setInterval>

  constructor(heartbeatMs = 25_000) {
    this.heartbeat = setInterval(() => {
      this.sweepPending()
    }, heartbeatMs)
    // Never hold the process open for the heartbeat alone.
    this.heartbeat.unref?.()
  }

  push(session: string, channel: string, args: unknown[]): void {
    const encodedArgs = args.map((arg) => encodeTransportValue(arg))
    const frame = `data: ${JSON.stringify({ channel, args: encodedArgs })}\n\n`
    const connections = this.connections.get(session)
    if (connections) {
      for (const response of connections) {
        try {
          response.write(frame)
        } catch {
          connections.delete(response)
        }
      }
    } else {
      const frames = this.pending.get(session) ?? []
      frames.push(frame)
      if (frames.length > PENDING_FRAMES_MAX) frames.shift()
      this.pending.set(session, frames)
      this.touched.set(session, Date.now())
    }
  }

  /** Attach an SSE response; replays any frames queued before reconnect. */
  attach(session: string, response: ServerResponse): () => void {
    const queued = this.pending.get(session)
    if (queued) {
      for (const frame of queued) response.write(frame)
      this.pending.delete(session)
      this.touched.delete(session)
    }
    let set = this.connections.get(session)
    if (!set) {
      set = new Set()
      this.connections.set(session, set)
    }
    set.add(response)

    let closed = false
    const teardown = () => {
      if (closed) return
      closed = true
      set!.delete(response)
      if (set!.size === 0) this.connections.delete(session)
      try {
        response.end()
      } catch {
        /* socket already gone */
      }
    }
    response.on('close', teardown)
    response.on('finish', teardown)
    return teardown
  }

  close(): void {
    clearInterval(this.heartbeat)
    for (const set of this.connections.values()) {
      for (const response of set) {
        try {
          response.end()
        } catch {
          /* ignore */
        }
      }
    }
    this.connections.clear()
    this.pending.clear()
    this.touched.clear()
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_FRAMES_TTL_MS
    for (const [session, touched] of this.touched) {
      if (touched < cutoff) {
        this.pending.delete(session)
        this.touched.delete(session)
      }
    }
  }
}