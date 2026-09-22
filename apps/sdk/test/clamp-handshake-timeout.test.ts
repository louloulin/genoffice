/**
 * SDK helper: clampHandshakeTimeout unit tests (sdk1.md §11.20).
 *
 * The handshake timer is the SDK's only safety net against a stuck
 * iframe. clampHandshakeTimeout is the boundary guard that prevents
 * a misconfigured host from making it instant (DoS via restart loop)
 * or unbounded (memory leak when the host disables it).
 *
 * Five-pin contract:
 *
 *   - `undefined` or non-number → 10_000 ms default (sdk1.md §11.20)
 *   - `NaN` / `Infinity` / `-Infinity` → 10_000 ms default
 *   - `< 1_000` ms → 1_000 ms floor (a 100 ms timer would fire before
 *     the iframe even has a chance to load)
 *   - `> 60_000` ms → 60_000 ms ceiling (a 24 h timer would leak
 *     memory if the host page is left open)
 *   - `1_000 ≤ ms ≤ 60_000` → `Math.floor(ms)`
 *   - fractional ms → floored (no sub-millisecond timers)
 */
import { describe, expect, it } from 'vitest'

import { clampHandshakeTimeout } from '../src/editor'

describe('clampHandshakeTimeout (sdk1.md §11.20)', () => {
  it('returns 10_000 ms default when input is undefined', () => {
    expect(clampHandshakeTimeout(undefined)).toBe(10_000)
  })

  it('returns 10_000 ms when input is NaN', () => {
    expect(clampHandshakeTimeout(NaN)).toBe(10_000)
  })

  it('returns 10_000 ms when input is Infinity', () => {
    expect(clampHandshakeTimeout(Infinity)).toBe(10_000)
  })

  it('returns 10_000 ms when input is -Infinity', () => {
    expect(clampHandshakeTimeout(-Infinity)).toBe(10_000)
  })

  it('clamps below 1_000 ms (host passes 100)', () => {
    expect(clampHandshakeTimeout(100)).toBe(1_000)
  })

  it('clamps below 1_000 ms (host passes 0)', () => {
    expect(clampHandshakeTimeout(0)).toBe(1_000)
  })

  it('clamps below 1_000 ms (host passes 999)', () => {
    expect(clampHandshakeTimeout(999)).toBe(1_000)
  })

  it('clamps above 60_000 ms (host passes 24 h)', () => {
    expect(clampHandshakeTimeout(24 * 60 * 60 * 1000)).toBe(60_000)
  })

  it('clamps above 60_000 ms (host passes 60_001)', () => {
    expect(clampHandshakeTimeout(60_001)).toBe(60_000)
  })

  it('passes through 1_000 ms (boundary)', () => {
    expect(clampHandshakeTimeout(1_000)).toBe(1_000)
  })

  it('passes through 60_000 ms (boundary)', () => {
    expect(clampHandshakeTimeout(60_000)).toBe(60_000)
  })

  it('passes through 10_000 ms (the default-equivalent)', () => {
    expect(clampHandshakeTimeout(10_000)).toBe(10_000)
  })

  it('floors fractional values (1500.7 → 1500)', () => {
    expect(clampHandshakeTimeout(1500.7)).toBe(1500)
  })

  it('floors fractional values (0.5 → 1_000 — clamped)', () => {
    // 0.5 < 1_000 so it goes through the < 1_000 branch, returns 1_000.
    expect(clampHandshakeTimeout(0.5)).toBe(1_000)
  })

  it('returns 10_000 ms when input is null (defensive)', () => {
    // Function signature says `number | undefined` but a careless host
    // might pass null. The `typeof !== 'number'` guard catches it.
    expect(clampHandshakeTimeout(null as unknown as number)).toBe(10_000)
  })

  it('returns 10_000 ms when input is a string (defensive)', () => {
    expect(clampHandshakeTimeout('10000' as unknown as number)).toBe(10_000)
  })
})
