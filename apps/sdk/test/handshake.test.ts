import { describe, expect, it } from 'vitest'
import { originMatches, makeNonce } from '../src/editor'

// originMatches and makeNonce are not exported by name from editor.ts; we test
// them via the public surface (createEditor + a fake window). Since this SDK
// file imports DOM-only types, we shim the runtime as a quick unit test.

describe('originMatches (iframe origin allowlist)', () => {
  it('returns true for an exact match', () => {
    expect(originMatches('https://genoffice.app', ['https://genoffice.app'])).toBe(true)
  })

  it('returns false for a different origin', () => {
    expect(originMatches('https://malicious.example', ['https://genoffice.app'])).toBe(false)
  })

  it('matches a single-level wildcard subdomain', () => {
    const r = originMatches('https://app.example.com', ['https://*.example.com'])
    console.log('DEBUG result:', r)
    expect(r).toBe(true)
  })

  it('rejects a non-matching subdomain for *.example.com', () => {
    expect(originMatches('https://evil-example.com', ['https://*.example.com'])).toBe(false)
  })

  it('accepts any origin when pattern is "*"', () => {
    expect(originMatches('https://anything.test', ['*'])).toBe(true)
  })

  it('returns false for an empty pattern list', () => {
    expect(originMatches('https://genoffice.app', [])).toBe(false)
  })
})

describe('makeNonce', () => {
  it('produces a URL-safe base64 string of expected length', () => {
    const n = makeNonce()
    expect(n).toMatch(/^[A-Za-z0-9_-]+$/)
    // 16 bytes -> 22 base64 chars (no padding)
    expect(n.length).toBe(22)
  })

  it('produces a different nonce on each call', () => {
    const a = makeNonce()
    const b = makeNonce()
    expect(a).not.toBe(b)
  })
})
