/**
 * Error surface for the loopback UI host. OfficeError instances (the headless
 * library's own typed errors) map onto the same HTTP status ladder
 * apps/web-server uses, so a renderer sees identical envelopes on both hosts.
 */
import { OfficeError } from '../errors'

export function ipcErrorStatus(code: string | undefined): number {
  switch (code) {
    case 'WEB_UNSUPPORTED':
      return 501
    case 'INVALID_ARGUMENT':
    case 'OFFICE_BAD_INPUT':
    case 'PAYLOAD_TOO_LARGE':
      return 400
    case 'CLIENT_ABORTED':
      return 400
    case 'NOT_FOUND':
    case 'OFFICE_NOT_FOUND':
      return 404
    case 'OFFICE_UNSUPPORTED':
    case 'OFFICE_NEEDS_APP':
    case 'OFFICE_NEEDS_SIDECAR':
      return 501
    case 'OFFICE_INTERNAL':
      return 500
    default:
      return 500
  }
}

export function sendIpcErrorPayload(error: unknown, channel: string): { status: number; body: unknown } {
  let classified: unknown = error
  if (
    error instanceof Error &&
    error.name === 'TypeError' &&
    /Cannot destructure property .* of .*as it is undefined|Cannot read properties of undefined \(reading/.test(
      error.message,
    )
  ) {
    classified = new OfficeError('OFFICE_BAD_INPUT', `${channel} was called without its required argument object`)
  }
  const errObj: { message: string; code?: string; channel?: string } = {
    message: classified instanceof Error ? classified.message : String(classified),
  }
  const anyErr = classified as { code?: unknown; channel?: unknown }
  if (typeof anyErr?.code === 'string') errObj.code = anyErr.code
  if (typeof anyErr?.channel === 'string') errObj.channel = anyErr.channel
  return { status: ipcErrorStatus(errObj.code), body: { error: errObj } }
}