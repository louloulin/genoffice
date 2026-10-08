/**
 * Per-host IPC handler registry. Unlike apps/web-server's module-level
 * singleton, a library host can have several instances in one process, so
 * `createRegistry()` returns an isolated registry; handler modules receive it
 * together with the host context and register their channels at boot.
 */

export type IpcHandler = (event: unknown, ...args: unknown[]) => unknown

export interface Registry {
  registerHandle(channel: string, handler: IpcHandler): void
  getHandlerEntry(channel: string): IpcHandler | undefined
  listChannels(): string[]
  handlerCount(): number
}

export function createRegistry(): Registry {
  const handlers = new Map<string, IpcHandler>()
  return {
    registerHandle(channel, handler) {
      handlers.set(channel, handler)
    },
    getHandlerEntry(channel) {
      return handlers.get(channel)
    },
    listChannels() {
      return [...handlers.keys()].sort()
    },
    handlerCount() {
      return handlers.size
    },
  }
}