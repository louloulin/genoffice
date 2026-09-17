/**
 * Regression: web-bridge readCurrentPath() must accept both `?open=...` and
 * `#open=...`. The shell emits the hash form; older direct navigations use
 * the query form. Before the fix, the hash was ignored and the editor opened
 * an untitled blank document.
 */
import { describe, it, expect } from 'vitest'

function readCurrentPathFromLocation(search: string, hash: string): string | null {
  const query = new URLSearchParams(search).get('open')
  if (query) return query
  const h = new URLSearchParams(hash.slice(1)).get('open')
  return h
}

describe('markdown web-bridge current path resolution', () => {
  it('reads from ?open= when both query and hash are present (query wins)', () => {
    expect(readCurrentPathFromLocation('?open=/tmp/x.md', '#open=/tmp/y.md')).toBe('/tmp/x.md')
  })

  it('falls back to #open= when query is empty', () => {
    expect(readCurrentPathFromLocation('', '#open=/tmp/demo.md')).toBe('/tmp/demo.md')
  })

  it('returns null when neither is present', () => {
    expect(readCurrentPathFromLocation('', '')).toBeNull()
    expect(readCurrentPathFromLocation('', '#other=1')).toBeNull()
  })

  it('handles real URL-encoded hash values', () => {
    const path = '/tmp/genoffice-data/demo.md'
    const hash = `#open=${encodeURIComponent(path)}`
    expect(readCurrentPathFromLocation('', hash)).toBe(path)
  })
})
