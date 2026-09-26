/**
 * `frame-ancestors` allowlist for the embed page (C.4).
 *
 * The `/embed/:docId` HTML is meant to be framed by the Dataflarework host on
 * a different origin, so the directive can't be `'none'`. It also can't be
 * absent: with no `frame-ancestors` the page is frameable by any origin
 * (clickjacking). The value comes from `EMBED_FRAME_ANCESTORS`, which makes
 * this a header-injection surface worth pinning — a hostile env value must
 * never be able to splice a second header or add CSP directives.
 */
import { describe, expect, it } from 'vitest'
import { parseFrameAncestors } from '../src/embed/index'

describe('parseFrameAncestors', () => {
  it('defaults to self when unset or empty', () => {
    expect(parseFrameAncestors(undefined)).toBe("'self'")
    expect(parseFrameAncestors('')).toBe("'self'")
    expect(parseFrameAncestors('   ')).toBe("'self'")
  })

  it('accepts a space- or comma-separated allowlist of https origins', () => {
    expect(parseFrameAncestors("'self' https://app.dataflarework.com")).toBe(
      "'self' https://app.dataflarework.com",
    )
    expect(parseFrameAncestors("'self',https://app.dataflarework.com,http://localhost:3000")).toBe(
      "'self' https://app.dataflarework.com http://localhost:3000",
    )
  })

  it('accepts a bare host with a port and no path', () => {
    expect(parseFrameAncestors('https://app.example.com:8443')).toBe('https://app.example.com:8443')
  })

  it('honours `*` and `none` only when they are the entire value', () => {
    expect(parseFrameAncestors('*')).toBe('*')
    expect(parseFrameAncestors("'none'")).toBe("'none'")
    // Combined with a list both are contradictory, and a stray `*` must not
    // be able to widen the policy to allow-all.
    expect(parseFrameAncestors("* 'self'")).toBe("'self'")
    expect(parseFrameAncestors("'self' *")).toBe("'self'")
    expect(parseFrameAncestors("'none' 'self'")).toBe("'self'")
  })

  it('falls back to self when every token is invalid', () => {
    expect(parseFrameAncestors('not-an-origin')).toBe("'self'")
    expect(parseFrameAncestors('ftp://example.com')).toBe("'self'")
    expect(parseFrameAncestors('example.com')).toBe("'self'")
  })

  it('fails closed on a malformed value rather than salvaging valid tokens', () => {
    // Per-token filtering would keep the bare `https://evil` here and the
    // bare `https://ok.example.com` below — i.e. a malformed config could
    // still widen the policy. Rejecting wholesale prevents that.
    expect(parseFrameAncestors("'self' bogus https://ok.example.com")).toBe("'self'")
    expect(parseFrameAncestors("'self'; report-uri https://evil")).toBe("'self'")
    expect(parseFrameAncestors('https://ok.example.com, bogus')).toBe("'self'")
  })

  it('refuses to let a value inject a second header or extra directives', () => {
    // A newline would terminate the header and start an attacker-controlled
    // one; a semicolon would splice in a second CSP directive.
    expect(parseFrameAncestors("https://a.example\r\nX-Evil: 1")).toBe("'self'")
    expect(parseFrameAncestors("'self'; script-src *")).toBe("'self'")
    expect(parseFrameAncestors("'self' https://a.example.com; report-uri https://evil")).toBe(
      "'self'",
    )
  })

  it('rejects origins with a path, query, or userinfo', () => {
    expect(parseFrameAncestors('https://a.example.com/path')).toBe("'self'")
    expect(parseFrameAncestors('https://a.example.com?x=1')).toBe("'self'")
    expect(parseFrameAncestors('https://user:pass@a.example.com')).toBe("'self'")
  })
})
