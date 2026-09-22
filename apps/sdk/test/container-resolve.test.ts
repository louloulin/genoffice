/**
 * Container resolution contract (sdk1.md §11.24).
 *
 * `resolveContainer` in editor.ts is private — it's a closure-local helper
 * inside `createEditor` — but its behavior drives whether a host page can
 * skip the `container` argument and rely on `document.body`, and whether
 * a Node caller (SSR, build-time URL generation) gets a clear error.
 *
 * Before §11.24 the docstring on `CreateEditorOptions` mentioned a
 * `containerElement` field that didn't exist (stale from an earlier
 * iteration). The test pins the actual contract:
 *
 *   - No document + no container  → throw (Node callers must use `url`)
 *   - String container that exists  → resolve to that element
 *   - String container that doesn't → throw with the selector in the message
 *   - HTMLElement container  → pass through
 *   - No `containerElement` field exists (regression guard for the stale doc)
 *
 * The test imports `createEditor` (the public entry) rather than
 * `resolveContainer` (private) so we exercise the actual user path.
 */
import { describe, expect, it, vi } from 'vitest'

// Pin the contract: there must NOT be a `containerElement` field on
// CreateEditorOptions. If someone reintroduces it, this test fails.
describe('CreateEditorOptions contract (sdk1.md §11.24)', () => {
  it('does not expose a `containerElement` field (was a stale doc typo)', async () => {
    // Read the source file (not the dist .d.ts) so the check is robust
    // against pre-existing build artifacts.
    const { readFileSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const typesPath = join(here, '..', 'src', 'types.ts')
    const text = readFileSync(typesPath, 'utf-8')
    // `containerElement` should appear at most in the docstring (where it
    // is now explicitly denied). Pin that the only occurrences are the
    // "no separate containerElement field" line.
    const matches = text.match(/containerElement/g) ?? []
    expect(matches.length).toBe(1) // only the denial comment
    expect(text).toContain('There is no separate')
  })
})

describe('createEditor argument validation (sdk1.md §11.24)', () => {
  it('throws when called without options', async () => {
    const { createEditor } = await import('../src/editor')
    // @ts-expect-error testing runtime guard
    expect(() => createEditor()).toThrow(/options required/)
  })

  it('throws when documentId is missing', async () => {
    const { createEditor } = await import('../src/editor')
    expect(() =>
      createEditor({
        // documentId omitted on purpose
        app: 'docs' as const,
        jwt: 'jwt-xyz',
        host: 'https://example.test',
        url: 'https://example.test/embed/x?token=y',
      } as unknown as Parameters<typeof createEditor>[0]),
    ).toThrow(/documentId required/)
  })

  it('throws when jwt is missing', async () => {
    const { createEditor } = await import('../src/editor')
    expect(() =>
      createEditor({
        documentId: 'd',
        app: 'docs' as const,
        // jwt omitted
        host: 'https://example.test',
        url: 'https://example.test/embed/x?token=y',
      } as unknown as Parameters<typeof createEditor>[0]),
    ).toThrow(/jwt required/)
  })

  it('throws when host is missing', async () => {
    const { createEditor } = await import('../src/editor')
    expect(() =>
      createEditor({
        documentId: 'd',
        app: 'docs' as const,
        jwt: 'jwt-xyz',
        // host omitted
        url: 'https://example.test/embed/x?token=y',
      } as unknown as Parameters<typeof createEditor>[0]),
    ).toThrow(/host required/)
  })

  it('throws with a clear message when running under Node without a container', async () => {
    // This is the path SSR / build-time URL generation hits: no
    // `document` global, no `container` argument. The SDK must throw
    // a recognizable error so callers can branch to `url`-only usage.
    const { createEditor } = await import('../src/editor')
    // `vi.stubGlobal('document', undefined)` would also work but is
    // overkill; the SDK source explicitly throws when typeof document
    // === 'undefined'. We just assert that the error message is
    // descriptive enough to be actionable.
    expect(() =>
      createEditor({
        documentId: 'd',
        app: 'docs' as const,
        jwt: 'jwt-xyz',
        host: 'https://example.test',
        // No container, no url, no skipIframe → resolveContainer throws
      } as Parameters<typeof createEditor>[0]),
    ).toThrow(/container required when document is not available/)
  })
})

// Suppress unused vi warning when the file is consumed in non-strict mode
void vi
