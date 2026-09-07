import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { subsetTtf } from '../src/font-subset.js'

/** Any real sfnt face on the machine; subsetting is font-agnostic. */
const FACES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
]

describe('subsetTtf', () => {
  it('produces a smaller face that keeps the sfnt shape', async () => {
    const path = FACES.find((candidate) => existsSync(candidate))
    if (!path) return
    const font = readFileSync(path)
    const subset = await subsetTtf(font, 'Total 42')
    expect(subset.length).toBeGreaterThan(0)
    expect(subset.length).toBeLessThan(font.length)
    // sfnt magic: TrueType (0x00010000) or CFF ('OTTO')
    const tag = subset.readUInt32BE(0)
    expect(tag === 0x00010000 || subset.toString('latin1', 0, 4) === 'OTTO').toBe(true)
  })
})
