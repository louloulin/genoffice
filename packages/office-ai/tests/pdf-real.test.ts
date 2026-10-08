/**
 * Real-file PDF behavior. The fixtures are the app's own encrypted and corrupt
 * PDFs (copied byte-for-byte from `apps/shell/tests/fixtures`), not synthesized
 * pages — an encrypted stream and a fuzzed container are exactly the inputs a
 * hand-built PDF never produces.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readDocument, render } from '../src/documents'
import { OfficeError } from '../src/errors'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

/** `apps/shell/tests/pdf-password-retry.test.ts`: the user password is four spaces. */
const PASSWORD = '    '

describe('encrypted pdf (real fixture)', () => {
  it('reports encryption from the structure without a password', async () => {
    const view = await readDocument(fixture('testPassword4Spaces.pdf'), { format: 'pdf' })
    expect(view.pdf).toMatchObject({ pages: null, encrypted: true })
  })

  it('reads the page count once the password is supplied', async () => {
    const view = await readDocument(fixture('testPassword4Spaces.pdf'), {
      format: 'pdf',
      password: PASSWORD,
    })
    expect(view.pdf).toMatchObject({ pages: 1, encrypted: true })
  })

  it('rasterizes the page when the password is supplied', async () => {
    const pngs = await render(fixture('testPassword4Spaces.pdf'), { format: 'pdf', password: PASSWORD })
    expect(pngs).toHaveLength(1)
    // a real page rasterizes to a real PNG, not an empty buffer
    expect(pngs[0]!.byteLength).toBeGreaterThan(1000)
    expect([...pngs[0]!.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('fails with a typed error rather than an empty page when no password is given', async () => {
    const err = await render(fixture('testPassword4Spaces.pdf'), { format: 'pdf' }).catch((e) => e)
    expect(err).toBeInstanceOf(OfficeError)
    expect(err.code).toBe('OFFICE_INTERNAL')
    expect((err.cause as { code?: string }).code).toBe('password-required')
  })
})

describe('corrupt pdf (real fixture)', () => {
  it('refuses the document with a branchable code', async () => {
    await expect(readDocument(fixture('corruptExample.pdf'), { format: 'pdf' })).rejects.toMatchObject(
      { code: 'OFFICE_INTERNAL' },
    )
    await expect(render(fixture('corruptExample.pdf'), { format: 'pdf' })).rejects.toMatchObject({
      code: 'OFFICE_INTERNAL',
    })
  })
})
