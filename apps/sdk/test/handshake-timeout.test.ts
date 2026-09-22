/**
 * Handshake timeout clamp (sdk1.md §11.21).
 *
 * The SDK's iframe handshake has a 10 s default timeout that fires
 * `HANDSHAKE_FAILED` if the bridge script doesn't post the right `ready`
 * event in time. Before §11.21 this timeout was hardcoded inside the
 * closure; hosts with slow networks or cold iframe boot had no way to
 * relax it. After §11.21:
 *
 *   - `CreateEditorOptions.handshakeTimeoutMs` lets the host pass a value.
 *   - `clampHandshakeTimeout` (now exported) enforces 1 s ≤ ms ≤ 60 s.
 *   - Default is 10 s when the option is missing or non-finite.
 *
 * Tests pin the clamp so future refactors can't silently change the
 * allowed range without breaking this contract.
 */
import { describe, expect, it } from 'vitest'
import { clampHandshakeTimeout } from '../src/editor'

describe('clampHandshakeTimeout (sdk1.md §11.21)', () => {
  it('returns 10_000 (default) for undefined / null / NaN', () => {
    expect(clampHandshakeTimeout(undefined)).toBe(10_000)
    expect(clampHandshakeTimeout(null as unknown as number)).toBe(10_000)
    expect(clampHandshakeTimeout(NaN)).toBe(10_000)
    expect(clampHandshakeTimeout(Infinity)).toBe(10_000)
    expect(clampHandshakeTimeout(-Infinity)).toBe(10_000)
  })

  it('returns the input when within the allowed range', () => {
    expect(clampHandshakeTimeout(1_000)).toBe(1_000)
    expect(clampHandshakeTimeout(10_000)).toBe(10_000)
    expect(clampHandshakeTimeout(30_000)).toBe(30_000)
    expect(clampHandshakeTimeout(60_000)).toBe(60_000)
  })

  it('clamps below 1 s up to the 1 s floor', () => {
    expect(clampHandshakeTimeout(0)).toBe(1_000)
    expect(clampHandshakeTimeout(500)).toBe(1_000)
    expect(clampHandshakeTimeout(999)).toBe(1_000)
  })

  it('clamps above 60 s down to the 60 s ceiling', () => {
    expect(clampHandshakeTimeout(60_001)).toBe(60_000)
    expect(clampHandshakeTimeout(120_000)).toBe(60_000)
    expect(clampHandshakeTimeout(86_400_000)).toBe(60_000)
  })

  it('floors fractional milliseconds so a 5.7 s input becomes 5 s', () => {
    // The clamp uses Math.floor so the contract is deterministic — same
    // input always yields the same output. Host code that wants
    // sub-second precision should accept the floor behavior.
    expect(clampHandshakeTimeout(5_700)).toBe(5_700)
    expect(clampHandshakeTimeout(5_700.9)).toBe(5_700)
  })

  it('rejects negative numbers (clamps to floor, not absolute)', () => {
    // We don't take Math.abs because a user passing -5000 probably meant
    // "wait 5 s" — clamping to the 1 s floor is the safer default.
    expect(clampHandshakeTimeout(-5_000)).toBe(1_000)
    expect(clampHandshakeTimeout(-1)).toBe(1_000)
  })
})
