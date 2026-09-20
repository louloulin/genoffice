/**
 * A promise-chain mutex, used to serialise the read-modify-write cycles that
 * back the JSON state files.
 *
 * Two concurrent `flushNow()` calls used to interleave: both read the map,
 * both wrote, and the second overwrote the first — silently losing the entries
 * the first had just persisted. Serialising the whole read-modify-write (not
 * just the write) is what makes the last flush authoritative.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  /** Run `fn` once every previously-queued task has settled. Rejections in
   *  earlier tasks do not poison the chain: a failed flush must not deadlock
   *  every later save. */
  runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/** Convenience wrapper for a one-off critical section. */
export function runExclusive<T>(mutex: Mutex, fn: () => Promise<T> | T): Promise<T> {
  return mutex.runExclusive(fn)
}
