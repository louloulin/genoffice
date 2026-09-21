/**
 * postMessage v1 envelope — wire format between the SDK host page and the
 * GenOffice embed iframe.
 *
 * Both directions use the same envelope shape:
 *
 *   {
 *     v: '1.0',
 *     dir: 'host→editor' | 'editor→host',
 *     kind: 'event' | 'command' | 'command-result',
 *     payload: <typed>
 *   }
 *
 * `command-result` carries an optional `correlationId` so the host can match
 * replies to outstanding commands even if the iframe sends multiple
 * concurrent commands.
 */

export const ENVELOPE_VERSION = '1.0' as const

export type EnvelopeKind = 'event' | 'command' | 'command-result'

export interface Envelope<T = unknown> {
  v: typeof ENVELOPE_VERSION
  dir: 'host→editor' | 'editor→host'
  kind: EnvelopeKind
  correlationId?: string
  payload: T
}

export interface CommandEnvelopePayload {
  name: string
  args?: unknown
}

export interface CommandResultEnvelopePayload {
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export function makeEvent(name: string, payload: unknown): Envelope {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'event',
    payload: { name, payload },
  }
}

export function makeCommand(name: string, args: unknown, correlationId: string): Envelope<CommandEnvelopePayload> {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'command',
    correlationId,
    payload: { name, args },
  }
}

export function makeCommandResult(correlationId: string, ok: boolean, result?: unknown, error?: { code: string; message: string }): Envelope<CommandResultEnvelopePayload> {
  return {
    v: ENVELOPE_VERSION,
    dir: 'host→editor',
    kind: 'command-result',
    correlationId,
    payload: { ok, ...(result !== undefined ? { result } : {}), ...(error ? { error } : {}) },
  }
}

/** Type guard for inbound envelopes — drops malformed postMessage traffic. */
export function isEnvelope(input: unknown): input is Envelope {
  if (!input || typeof input !== 'object') return false
  const e = input as Record<string, unknown>
  if (e.v !== ENVELOPE_VERSION) return false
  if (e.dir !== 'editor→host' && e.dir !== 'host→editor') return false
  if (e.kind !== 'event' && e.kind !== 'command' && e.kind !== 'command-result') return false
  return true
}
