/**
 * HTTP status mapping for IPC failures.
 *
 * Every structured error code except `WEB_UNSUPPORTED` used to answer 500, and
 * a handler that destructured a missing object argument threw a bare TypeError
 * that nobody classified. The result was 107 of 531 registered channels
 * answering a plain no-argument call with "server error" — unactionable for
 * both the retry logic and the user, and it hid real faults in the noise.
 *
 * These assertions pin the contract the transport promises to clients: a
 * malformed request is 4xx, a missing file is 404, an unsupported channel is
 * 501, and only genuinely unexpected throws stay 500.
 */
import { describe, expect, it } from 'vitest'

import {
  CorruptError,
  InvalidArgumentError,
  NotFoundError,
  WebUnsupportedError,
  classifyWebError,
  ipcErrorStatus,
} from '../src/ai/errors'

describe('ipcErrorStatus', () => {
  it('maps each structured code to the status a client can act on', () => {
    expect(ipcErrorStatus('WEB_UNSUPPORTED')).toBe(501)
    expect(ipcErrorStatus('INVALID_ARGUMENT')).toBe(400)
    expect(ipcErrorStatus('NOT_FOUND')).toBe(404)
    expect(ipcErrorStatus('CORRUPT')).toBe(422)
  })

  it('keeps a genuinely unknown failure at 500', () => {
    expect(ipcErrorStatus(undefined)).toBe(500)
    expect(ipcErrorStatus('SOMETHING_ELSE')).toBe(500)
  })
})

describe('classifyWebError', () => {
  it('reads a destructure failure on a missing args object as a bad request', () => {
    const raw = new TypeError("Cannot destructure property 'docId' of 'args' as it is undefined.")
    const classified = classifyWebError(raw, 'collab:join')
    expect(classified).toBeInstanceOf(InvalidArgumentError)
    expect((classified as InvalidArgumentError).code).toBe('INVALID_ARGUMENT')
    expect((classified as InvalidArgumentError).channel).toBe('collab:join')
    expect(ipcErrorStatus((classified as InvalidArgumentError).code)).toBe(400)
  })

  it('reads a property read on undefined the same way', () => {
    const raw = new TypeError("Cannot read properties of undefined (reading 'requestId')")
    expect(classifyWebError(raw, 'ai:stream')).toBeInstanceOf(InvalidArgumentError)
  })

  it('leaves a TypeError that is not about missing arguments alone', () => {
    // A TypeError from inside a handler is a real bug and must stay a 500 so
    // it is reported as one instead of being blamed on the caller.
    const raw = new TypeError('x.forEach is not a function')
    const classified = classifyWebError(raw, 'sheets:read-range')
    expect(classified).toBe(raw)
    expect(ipcErrorStatus(undefined)).toBe(500)
  })

  it('rebuilds each structured code from the wire payload', () => {
    expect(
      classifyWebError({ code: 'WEB_UNSUPPORTED', channel: 'ai:slides-translate', reason: 'renderer-side skill' }, 'x'),
    ).toBeInstanceOf(WebUnsupportedError)
    expect(classifyWebError({ code: 'INVALID_ARGUMENT', reason: 'missing id' }, 'x')).toBeInstanceOf(
      InvalidArgumentError,
    )
    expect(classifyWebError({ code: 'NOT_FOUND', reason: 'gone' }, 'x')).toBeInstanceOf(NotFoundError)
    expect(classifyWebError({ code: 'CORRUPT', reason: 'bad bytes' }, 'x')).toBeInstanceOf(CorruptError)
  })

  it('falls back to the channel the dispatcher knows when the payload omits one', () => {
    const classified = classifyWebError({ code: 'NOT_FOUND', reason: 'gone' }, 'pdf:read-file') as NotFoundError
    expect(classified.channel).toBe('pdf:read-file')
  })
})
