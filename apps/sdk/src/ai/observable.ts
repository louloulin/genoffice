/**
 * Minimal Observable<T> primitive — zero deps.
 *
 * Mirrors the subset of RxJS the SDK actually needs: `subscribe(observer)`,
 * returning a subscription with `unsubscribe()`. No operators, no schedulers.
 *
 * Why not RxJS? Zero-deps policy. The interface below is exactly the shape
 * the SDK exposes; an RxJS consumer can wrap it in `from()` if they want.
 */
export interface Observer<T> {
  next?: (value: T) => void
  error?: (err: unknown) => void
  complete?: () => void
}

export interface Subscription {
  unsubscribe(): void
  closed: boolean
}

export interface Observable<T> {
  subscribe(observer: Observer<T>): Subscription
}

/**
 * Build an Observable from an arbitrary producer. The producer receives an
 * `onNext` / `onError` / `onComplete` triple plus a teardown callback. The
 * returned Observable is single-shot (multi-shot Observables are out of
 * scope for the SDK's stream use case).
 *
 * Producer contract:
 *   - Call `onNext` for each value.
 *   - Call `onError` exactly once to terminate with an error.
 *   - Call `onComplete` exactly once to terminate normally.
 *   - Subscribe returns a Subscription. Calling `unsubscribe()` invokes the
 *     teardown function the producer registered, so cleanup always runs.
 *   - If the consumer unsubscribes before any of the above, the teardown
 *     still runs — calling `onNext` / `onError` / `onComplete` after that is
 *     a no-op (the subscription is `closed`).
 */
export function createObservable<T>(
  producer: (next: (v: T) => void, error: (e: unknown) => void, complete: () => void) => () => void,
): Observable<T> {
  return {
    subscribe(observer) {
      let closed = false
      const safeNext = (v: T) => {
        if (closed) return
        observer.next?.(v)
      }
      const safeError = (e: unknown) => {
        if (closed) return
        closed = true
        observer.error?.(e)
      }
      const safeComplete = () => {
        if (closed) return
        closed = true
        observer.complete?.()
      }
      let teardown: (() => void) | undefined
      try {
        teardown = producer(safeNext, safeError, safeComplete)
      } catch (err) {
        safeError(err)
      }
      return {
        get closed() {
          return closed
        },
        unsubscribe() {
          if (closed) return
          closed = true
          try {
            teardown?.()
          } catch {
            /* swallow teardown errors */
          }
        },
      }
    },
  }
}