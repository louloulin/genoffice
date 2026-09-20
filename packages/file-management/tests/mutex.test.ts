/**
 * The mutex is what stops two concurrent flushes from interleaving their
 * read-modify-write cycles and losing entries. The properties that matter:
 * tasks never overlap, order is preserved, and a rejection does not poison
 * the chain (a failed flush must not deadlock every later save).
 */
import { describe, expect, it } from 'vitest'
import { Mutex, runExclusive } from '../src/mutex'

const tick = (ms = 0) => new Promise((res) => setTimeout(res, ms))

describe('Mutex', () => {
  it('never runs two tasks concurrently', async () => {
    const mutex = new Mutex()
    let active = 0
    let maxActive = 0
    const task = async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await tick(5)
      active -= 1
    }
    await Promise.all(Array.from({ length: 20 }, () => mutex.runExclusive(task)))
    expect(maxActive).toBe(1)
  })

  it('runs tasks in submission order', async () => {
    const mutex = new Mutex()
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutex.runExclusive(async () => {
          await tick(1)
          order.push(i)
        }),
      ),
    )
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('returns each task result to its own caller', async () => {
    const mutex = new Mutex()
    const results = await Promise.all([1, 2, 3].map((n) => mutex.runExclusive(async () => n * 10)))
    expect(results).toEqual([10, 20, 30])
  })

  it('supports a synchronous task function', async () => {
    const mutex = new Mutex()
    expect(await mutex.runExclusive(() => 'sync')).toBe('sync')
  })

  it('keeps running later tasks after an earlier one rejects', async () => {
    const mutex = new Mutex()
    const boom = mutex.runExclusive(async () => {
      throw new Error('flush failed')
    })
    await expect(boom).rejects.toThrow('flush failed')
    // The chain must have absorbed the rejection, not stalled on it.
    expect(await mutex.runExclusive(() => 'still alive')).toBe('still alive')
  })

  it('reports the rejection only to the failing caller', async () => {
    const mutex = new Mutex()
    const failing = mutex.runExclusive(() => {
      throw new Error('only me')
    })
    const ok = mutex.runExclusive(() => 'fine')
    await expect(failing).rejects.toThrow('only me')
    await expect(ok).resolves.toBe('fine')
  })

  it('serialises a burst of read-modify-write cycles without losing an update', async () => {
    const mutex = new Mutex()
    let value = 0
    await Promise.all(
      Array.from({ length: 50 }, () =>
        mutex.runExclusive(async () => {
          const observed = value
          await tick(1)
          value = observed + 1
        }),
      ),
    )
    expect(value).toBe(50)
  })

  it('runExclusive wraps a standalone mutex', async () => {
    const mutex = new Mutex()
    expect(await runExclusive(mutex, () => 42)).toBe(42)
  })
})
