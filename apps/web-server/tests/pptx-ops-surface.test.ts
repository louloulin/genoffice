/**
 * pptx-ops surface pin — keeps the @genoffice/pptx-ops op count in sync with
 * sdk1.md. Without this, the "63 ops" claim silently drifts whenever someone
 * adds an op without updating the docs. The assertion here is the single
 * source of truth.
 *
 * If you add a new op: bump `EXPECTED_OP_COUNT` AND update sdk1.md §0.3 +
 * §11.7 in the same commit. The CI failure here is intentional.
 */
import { describe, expect, it } from 'vitest'
// Importing the root barrel triggers `import './core-ops' / './text-ops' /
// ...` side-effects that populate the op registry before opNames() runs.
import { opNames } from '@genoffice/pptx-ops'

// If you add an op, bump this number and update sdk1.md §0.3 / §11.7.
const EXPECTED_OP_COUNT = 63

describe('@genoffice/pptx-ops surface', () => {
  it('registers the expected number of ops (sdk1.md pin)', () => {
    const ops = opNames()
    expect(
      ops.length,
      `expected ${EXPECTED_OP_COUNT} ops but registry has ${ops.length}: ${ops.join(', ')}`,
    ).toBe(EXPECTED_OP_COUNT)
  })

  it('all op names are unique', () => {
    const ops = opNames()
    const unique = new Set(ops)
    expect(unique.size).toBe(ops.length)
  })

  it('exports a non-empty op list (sanity)', () => {
    expect(opNames().length).toBeGreaterThan(0)
  })

  it('includes the canonical high-impact ops by name', () => {
    // Pin a few names that the renderer + slides e2e tests actually use,
    // so renaming them shows up as a failing test rather than a silent
    // "no-op rename" in the diff.
    const ops = new Set(opNames())
    for (const must of ['addElement', 'setText', 'setFill', 'setTransform', 'deleteElement', 'addBlankSlide', 'setBackground']) {
      expect(ops.has(must), `op "${must}" should be in the registry`).toBe(true)
    }
  })
})
