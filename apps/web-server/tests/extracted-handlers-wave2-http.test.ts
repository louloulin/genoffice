/// Standalone HTTP coverage for the second extraction wave: saved signatures and
/// generated-output naming from @genoffice/pdf-export-service, plus the TIFF/JPEG
/// /audio normalizers from @genoffice/slides-render-service. Everything runs
/// against a real loopback server, so the Web form is proven, not assumed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWebComposition } from '../src/main.js'

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

/** 1x1 grayscale TIFF (little endian, uncompressed) built by hand. */
function tinyTiff(): Uint8Array {
  const entries: Array<[number, number, number, number]> = [
    [0x0100, 3, 1, 1], // ImageWidth
    [0x0101, 3, 1, 1], // ImageLength
    [0x0102, 3, 1, 8], // BitsPerSample
    [0x0103, 3, 1, 1], // Compression = none
    [0x0106, 3, 1, 1], // PhotometricInterpretation = BlackIsZero
    [0x0111, 4, 1, 8], // StripOffsets -> pixel byte at 8
    [0x0115, 3, 1, 1], // SamplesPerPixel
    [0x0116, 3, 1, 1], // RowsPerStrip
    [0x0117, 4, 1, 1], // StripByteCounts
  ]
  const ifdOffset = 16
  const buffer = Buffer.alloc(ifdOffset + 2 + entries.length * 12 + 4)
  buffer.write('II', 0, 'latin1')
  buffer.writeUInt16LE(42, 2)
  buffer.writeUInt32LE(ifdOffset, 4)
  buffer.writeUInt8(0x7f, 8) // the single pixel
  buffer.writeUInt16LE(entries.length, ifdOffset)
  entries.forEach(([tag, type, count, value], index) => {
    const at = ifdOffset + 2 + index * 12
    buffer.writeUInt16LE(tag, at)
    buffer.writeUInt16LE(type, at + 2)
    buffer.writeUInt32LE(count, at + 4)
    if (type === 3) buffer.writeUInt16LE(value, at + 8)
    else buffer.writeUInt32LE(value, at + 8)
  })
  return new Uint8Array(buffer)
}

/** Minimal JPEG carrying one EXIF IFD0 entry: Orientation. */
function jpegWithOrientation(orientation: number): Uint8Array {
  // "Exif\0\0" + TIFF header (8) + entry count (2) + one entry (12) + next-IFD (4)
  const exif = Buffer.alloc(6 + 8 + 2 + 12 + 4)
  exif.write('Exif\0\0', 0, 'latin1')
  exif.write('II', 6, 'latin1')
  exif.writeUInt16LE(42, 8)
  exif.writeUInt32LE(8, 10) // IFD0 sits 8 bytes after the TIFF header
  exif.writeUInt16LE(1, 14) // one entry
  exif.writeUInt16LE(0x0112, 16) // Orientation
  exif.writeUInt16LE(3, 18) // SHORT
  exif.writeUInt32LE(1, 20)
  exif.writeUInt16LE(orientation, 24)
  exif.writeUInt32LE(0, 26) // no next IFD
  const length = Buffer.alloc(2)
  length.writeUInt16BE(exif.length + 2)
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1]),
      length,
      exif,
      Buffer.from([0xff, 0xd9]),
    ]),
  )
}

/** Byte offset of the Orientation value inside the JPEG built above. */
const ORIENTATION_VALUE_OFFSET = 2 + 4 + 24

describe('saved signatures over standalone HTTP', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'genoffice-signatures-'))
  })

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true })
  })

  it('adds, lists, removes and validates signatures', async () => {
    const app = await createWebComposition({ port: 0, dataDir })
    try {
      expect((await call(app.server.port, 'pdf:list-signatures', [])).body.result).toEqual([])

      const added = await call(app.server.port, 'pdf:add-signature', [
        { kind: 'image', image: 'aGk=', width: 40, height: 20 },
      ])
      expect(added.status).toBe(200)
      expect(added.body.result).toHaveLength(1)
      const id = added.body.result[0].id
      expect(typeof id).toBe('string')

      const strokes = await call(app.server.port, 'pdf:add-signature', [
        { kind: 'strokes', paths: [[0, 0, 10, 10]], width: 30, height: 15 },
      ])
      expect(strokes.body.result).toHaveLength(2)

      const rejected = await call(app.server.port, 'pdf:add-signature', [
        { kind: 'image', image: '', width: 0, height: 0 },
      ])
      expect(rejected.status).toBe(500)
      expect(rejected.body.error?.message).toContain('expects signature data')

      const removed = await call(app.server.port, 'pdf:remove-signature', [id])
      expect(removed.body.result.map((entry: { id: string }) => entry.id)).not.toContain(id)
    } finally {
      await app.server.close()
    }
  })

  it('persists signatures across server restarts', async () => {
    const first = await createWebComposition({ port: 0, dataDir })
    try {
      await call(first.server.port, 'pdf:add-signature', [
        { kind: 'image', image: 'aGk=', width: 10, height: 10 },
      ])
    } finally {
      await first.server.close()
    }
    const second = await createWebComposition({ port: 0, dataDir })
    try {
      expect((await call(second.server.port, 'pdf:list-signatures', [])).body.result).toHaveLength(
        1,
      )
    } finally {
      await second.server.close()
    }
  })
})

describe('export naming over standalone HTTP', () => {
  it('avoids colliding with an existing generated file', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'genoffice-generated-'))
    const app = await createWebComposition({ port: 0, dataDir })
    try {
      const first = await call(app.server.port, 'pdf:generated-output-path', ['report.pdf'])
      expect(first.status).toBe(200)
      expect(String(first.body.result).endsWith('.pdf')).toBe(true)
      expect(String(first.body.result).startsWith(dataDir)).toBe(true)

      const sanitized = await call(app.server.port, 'pdf:generated-output-path', ['a/b:c*.pdf'])
      expect(String(sanitized.body.result)).not.toContain(':')

      const rejected = await call(app.server.port, 'pdf:generated-output-path', [''])
      expect(rejected.status).toBe(500)
    } finally {
      await app.server.close()
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('media normalizers over standalone HTTP', () => {
  it('transcodes TIFF to PNG and reports non-TIFF input as null', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const decoded = await call(app.server.port, 'slides:tiff-to-png', [tinyTiff()])
      expect(decoded.status).toBe(200)
      expect(decoded.body.result?.width).toBe(1)
      expect(decoded.body.result?.height).toBe(1)
      const png = Buffer.from(decoded.body.result.png.b64, 'base64')
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')

      const notTiff = await call(app.server.port, 'slides:tiff-to-png', [
        new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      ])
      expect(notTiff.body.result).toBe(null)
    } finally {
      await app.server.close()
    }
  })

  it('bakes EXIF orientation out of a JPEG', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const rotated = jpegWithOrientation(6)
      const normalized = await call(app.server.port, 'slides:normalize-jpeg', [rotated])
      expect(normalized.status).toBe(200)
      const bytes = Buffer.from(normalized.body.result.b64, 'base64')
      // Still a JPEG, and the orientation tag no longer claims a rotation.
      expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
      expect(rotated[ORIENTATION_VALUE_OFFSET]).toBe(6)
      expect(bytes[ORIENTATION_VALUE_OFFSET]).toBe(1)
      expect(bytes.length).toBe(rotated.length)

      // An already-upright JPEG is returned untouched.
      const upright = jpegWithOrientation(1)
      const unchanged = await call(app.server.port, 'slides:normalize-jpeg', [upright])
      expect(Buffer.from(unchanged.body.result.b64, 'base64')).toEqual(Buffer.from(upright))
    } finally {
      await app.server.close()
    }
  })

  it('reports audio playability for a non-mp4 payload', async () => {
    const app = await createWebComposition({ port: 0 })
    try {
      const result = await call(app.server.port, 'slides:audio-support', [
        new Uint8Array([0x00, 0x01, 0x02, 0x03]),
      ])
      expect(result.status).toBe(200)
      expect(Array.isArray(result.body.result.formats)).toBe(true)
      expect(result.body.result.unplayable).toBe(null)
    } finally {
      await app.server.close()
    }
  })
})
