/// Standalone HTTP coverage for the capabilities extracted out of the Electron
/// main processes: the PDF export font path (@genoffice/pdf-export-service) and
/// the slides rendering/font path (@genoffice/slides-render-service). Every
/// assertion goes through a real loopback server, so a regression in the
/// extraction shows up as an HTTP failure and not just a unit-test failure.

import { existsSync, readFileSync } from 'node:fs'
import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { createWebComposition } from '../src/main.js'

/** Any real sfnt face on the runner; the export path is font-agnostic. */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
]

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return {
    status: response.status,
    body: (await response.json()) as { result?: any; error?: { message?: string } },
  }
}

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CFB_HEADER = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

describe('extracted PDF export handlers over standalone HTTP', () => {
  it('probes font coverage and rejects malformed input', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const empty = await call(app.server.port, 'pdf:font-covers-text', [new Uint8Array(0), '\r\n'])
      expect(empty.status).toBe(200)
      expect(empty.body.result).toBe(true)

      const garbage = await call(app.server.port, 'pdf:font-covers-text', [new Uint8Array(64), 'x'])
      expect(garbage.body.result).toBe(false)

      const bad = await call(app.server.port, 'pdf:font-covers-text', ['not-bytes', 'x'])
      expect(bad.status).toBe(500)
      expect(bad.body.error?.message).toContain('expects font bytes')
    } finally {
      await app.server.close()
    }
  })

  it('answers coverage and subsets a real face when one is installed', async () => {
    const path = FONT_CANDIDATES.find((candidate) => existsSync(candidate))
    if (!path) return
    const font = new Uint8Array(readFileSync(path))
    const app = await createWebComposition({ port: 0 })
    try {
      const covered = await call(app.server.port, 'pdf:font-covers-text', [font, 'Total 42'])
      expect(covered.status).toBe(200)
      expect(covered.body.result).toBe(true)

      const subset = await call(app.server.port, 'pdf:subset-font', [font, 'Total 42'])
      expect(subset.status).toBe(200)
      expect(subset.body.result.__ipcBytes).toBe('u8')
      const bytes = Buffer.from(subset.body.result.b64, 'base64')
      expect(bytes.length).toBeGreaterThan(0)
      expect(bytes.length).toBeLessThan(font.byteLength)
    } finally {
      await app.server.close()
    }
  })
})

describe('extracted slides render handlers over standalone HTTP', () => {
  it('serves the font catalog without Electron', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const catalog = await call(app.server.port, 'slides:font-catalog', [])
      expect(catalog.status).toBe(200)
      expect(Array.isArray(catalog.body.result)).toBe(true)
      expect(catalog.body.result.length).toBeGreaterThan(0)
      expect(catalog.body.result[0]).toHaveProperty('files')
    } finally {
      await app.server.close()
    }
  })

  it('sniffs media mime from magic bytes over the extension', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      // A PNG mislabeled as .emf must render as PNG, not route into the EMF parser.
      const mislabeled = await call(app.server.port, 'slides:media-mime', [
        'media/image1.emf',
        PNG_HEADER,
      ])
      expect(mislabeled.status).toBe(200)
      expect(mislabeled.body.result).toBe('image/png')

      const byExtension = await call(app.server.port, 'slides:media-mime', [
        'media/image2.svg',
        new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      ])
      expect(byExtension.body.result).toBe('image/svg+xml')
    } finally {
      await app.server.close()
    }
  })

  it('classifies CFB containers and plain payloads', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const legacy = await call(app.server.port, 'slides:container-kind', [CFB_HEADER])
      expect(legacy.body.result).toBe('legacy')

      const encrypted = await call(app.server.port, 'slides:container-kind', [
        new Uint8Array([...CFB_HEADER, ...Buffer.from('EncryptedPackage', 'utf16le')]),
      ])
      expect(encrypted.body.result).toBe('encrypted')

      const notCfb = await call(app.server.port, 'slides:container-kind', [PNG_HEADER])
      expect(notCfb.body.result).toBe(null)
    } finally {
      await app.server.close()
    }
  })
})
