/**
 * Single IPC handler registry shared by every capability module.
 *
 * `apps/web-server/src/index.ts` instantiates one registry at startup; each
 * module imports `registerHandle` and pushes its handlers at module load
 * time. The HTTP layer then walks `handlers` to dispatch `/api/ipc/:channel`
 * requests and the boot banner reports `handlers.size`.
 *
 * Scope gate (sdk1 §A.5 #10 audit:log close): `registerHandle(channel, handler, options)`
 * accepts an optional `scope` field. When the dispatcher sees a registered
 * scope for the channel, it calls `requireScopeFromHeaders` before invoking
 * the handler and returns a structured 401/403 envelope if the caller does
 * not present a JWT carrying that scope. Channels that do not opt in keep
 * the existing behavior (WEB_TOKEN-based trust, no scope check).
 */

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface HandleOptions {
  /**
   * OAuth-style scope required to invoke this channel via /api/ipc. The
   * IPC dispatcher calls `requireScopeFromHeaders(headers, scope)` before
   * running the handler. Wildcards (`audit:*`, `*`) work because the
   * underlying `hasScope` honours prefix matching.
   */
  scope?: string
}

interface HandlerEntry {
  handler: IpcHandler
  scope?: string
}

const handlers = new Map<string, HandlerEntry>()

export function registerHandle(
  channel: string,
  handler: IpcHandler,
  options?: HandleOptions,
): void {
  const entry: HandlerEntry = { handler }
  if (options?.scope) entry.scope = options.scope
  handlers.set(channel, entry)
}

export function getHandler(channel: string): IpcHandler | undefined {
  return handlers.get(channel)?.handler
}

/**
 * Returns the handler + its scope metadata so the dispatcher can run the
 * scope check before invocation. Internal callers should prefer this over
 * `getHandler` when they need to honour the gate.
 */
export function getHandlerEntry(channel: string): HandlerEntry | undefined {
  return handlers.get(channel)
}

export function listChannels(): string[] {
  return [...handlers.keys()].sort()
}

export function handlerCount(): number {
  return handlers.size
}
