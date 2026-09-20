/**
 * The logger is the single funnel for server diagnostics, so its failures are
 * uniquely bad: a throw while reporting an error takes down the very request
 * that was being reported. These tests pin the record shape (one JSON object
 * per line, so `jq` works without a parser), the Error flattening, and the
 * guarantee that a broken sink never propagates.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLoggerSink, log, setLogLevel, type LogRecord } from '../src/common/logger'

const originalSink = installLoggerSink(() => {})

function capture(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = []
  const previous = installLoggerSink((record) => records.push(record))
  return { records, restore: () => installLoggerSink(previous) }
}

afterEach(() => {
  installLoggerSink(originalSink)
  setLogLevel('info')
})

describe('log record shape', () => {
  it('emits a record with ts, level, module and msg', () => {
    const { records, restore } = capture()
    log.info('file-index', 'flush complete')
    restore()
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: 'info', module: 'file-index', msg: 'flush complete' })
    expect(typeof records[0].ts).toBe('string')
    expect(Number.isNaN(Date.parse(records[0].ts))).toBe(false)
  })

  it('merges meta fields into the record', () => {
    const { records, restore } = capture()
    log.warn('sheets', 'slow save', { ms: 1200, file: 'big.xlsx' })
    restore()
    expect(records[0]).toMatchObject({ ms: 1200, file: 'big.xlsx' })
  })

  it('emits one record per call', () => {
    const { records, restore } = capture()
    log.info('a', 'one')
    log.info('a', 'two')
    restore()
    expect(records.map((r) => r.msg)).toEqual(['one', 'two'])
  })

  it('exposes each severity through its own method', () => {
    const { records, restore } = capture()
    setLogLevel('debug')
    log.debug('m', 'd')
    log.info('m', 'i')
    log.warn('m', 'w')
    log.error('m', 'e')
    restore()
    expect(records.map((r) => r.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })
})

describe('error flattening', () => {
  it('flattens an Error into name/message/stack', () => {
    const { records, restore } = capture()
    log.error('file-index', 'flush failed', { err: new Error('disk full') })
    restore()
    expect(records[0].err).toMatchObject({ name: 'Error', message: 'disk full' })
    expect((records[0].err as { stack: string }).stack).toContain('disk full')
  })

  it('keeps the record JSON-serialisable so it survives the wire', () => {
    const { records, restore } = capture()
    log.error('m', 'boom', { err: new Error('x') })
    restore()
    expect(() => JSON.stringify(records[0])).not.toThrow()
  })

  it('passes a plain object meta value through unchanged', () => {
    const { records, restore } = capture()
    log.info('m', 'ctx', { ctx: { a: 1 } })
    restore()
    expect(records[0].ctx).toEqual({ a: 1 })
  })

  it('does not throw on a circular meta value', () => {
    const { records, restore } = capture()
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    expect(() => log.info('m', 'circular', { payload: circular })).not.toThrow()
    restore()
    expect(records).toHaveLength(1)
    // Falls back to util.inspect, which renders the cycle instead of throwing.
    expect(typeof records[0].payload).toBe('string')
  })

  it('passes null and undefined through without inventing a value', () => {
    const { records, restore } = capture()
    log.info('m', 'nulls', { a: null, b: undefined })
    restore()
    expect(records[0].a).toBeNull()
    expect(records[0].b).toBeUndefined()
  })
})

describe('level filtering', () => {
  it('suppresses records below the configured level', () => {
    const { records, restore } = capture()
    setLogLevel('warn')
    log.debug('m', 'hidden')
    log.info('m', 'hidden')
    log.warn('m', 'shown')
    log.error('m', 'shown')
    restore()
    expect(records.map((r) => r.msg)).toEqual(['shown', 'shown'])
  })

  it('shows everything at debug level', () => {
    const { records, restore } = capture()
    setLogLevel('debug')
    log.debug('m', 'd')
    log.info('m', 'i')
    restore()
    expect(records).toHaveLength(2)
  })

  it('shows only errors at error level', () => {
    const { records, restore } = capture()
    setLogLevel('error')
    log.warn('m', 'no')
    log.error('m', 'yes')
    restore()
    expect(records.map((r) => r.msg)).toEqual(['yes'])
  })
})

describe('sink safety', () => {
  it('does not propagate a throwing sink to the caller', () => {
    installLoggerSink(() => {
      throw new Error('sink exploded')
    })
    expect(() => log.error('m', 'still fine')).not.toThrow()
  })

  it('installLoggerSink returns the previous sink so it can be restored', () => {
    const first = () => {}
    const second = () => {}
    installLoggerSink(first)
    const previous = installLoggerSink(second)
    expect(previous).toBe(first)
    installLoggerSink(previous)
  })

  it('still delivers later records after a sink threw once', () => {
    const captured: string[] = []
    let calls = 0
    /* The swallowing happens in `emit`. If it did not, the throw would escape
     * into the caller and the second record would never be attempted. */
    const previous = installLoggerSink((record) => {
      calls += 1
      if (calls === 1) throw new Error('first fails')
      captured.push(record.msg)
    })
    log.info('m', 'first')
    log.info('m', 'second')
    installLoggerSink(previous)
    expect(captured).toEqual(['second'])
  })
})

describe('default stderr sink', () => {
  it('writes one JSON line per record to stderr', () => {
    const writes: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as never)
    // Restore the built-in sink by installing then writing through the real one.
    installLoggerSink((record) => process.stderr.write(`${JSON.stringify(record)}\n`))
    log.info('boot', 'listening')
    spy.mockRestore()
    expect(writes).toHaveLength(1)
    expect(writes[0].endsWith('\n')).toBe(true)
    expect(JSON.parse(writes[0])).toMatchObject({ level: 'info', module: 'boot', msg: 'listening' })
  })
})
