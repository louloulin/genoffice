/**
 * postMessage envelope v1 — the browser-side mirror of the server's bridge
 * (`src/ui/embed/bridge.ts`). Kept byte-compatible with `@genoffice/web-sdk`'s
 * `envelope.ts` so a host written against the SDK's `EditorHandle` behaves
 * identically here.
 *
 *   { v: '1.0', dir: 'host→editor' | 'editor→host',
 *     kind: 'event' | 'command' | 'command-result',
 *     correlationId?, payload }
 */
export const ENVELOPE_VERSION = '1.0' as const

export interface Envelope<T = unknown> {
  v: typeof ENVELOPE_VERSION
  dir: 'host→editor' | 'editor→host'
  kind: 'event' | 'command' | 'command-result'
  correlationId?: string
  payload: T
}

export interface CommandResultPayload {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export function makeCommand(
  name: string,
  args: unknown,
  correlationId: string,
): Envelope<{ name: string; args?: unknown }> {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'command',
    correlationId,
    payload: { name, args },
  }
}

export function makeEvent<T>(name: string, payload: T): Envelope<{ name: string; payload: T }> {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'event',
    payload: { name, payload },
  }
}

/**
 * Guard for inbound envelopes. The bridge is a third-party frame that runs
 * same-machine code we do not control the deployment of, so `dir` is checked
 * alongside the version — a frame that can post at all can also forge a
 * `command-result` for a correlationId it guessed.
 */
export function isEnvelope(input: unknown): input is Envelope {
  if (!input || typeof input !== 'object') return false
  const e = input as Record<string, unknown>
  if (e.v !== ENVELOPE_VERSION) return false
  if (e.dir !== 'editor→host' && e.dir !== 'host→editor') return false
  if (e.kind !== 'event' && e.kind !== 'command' && e.kind !== 'command-result') return false
  return true
}
