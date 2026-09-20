/**
 * Thumbnail generation must stay honest when the host has no image library.
 *
 * The failure mode this guards against is fabricating a thumbnail: a grid full
 * of blank or wrong images is worse than the per-format icon it already has.
 * The resizer is therefore an injected optional dependency, and its absence
 * must produce `unsupported` rather than a fake success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearPreviewCache,
  generatePreview,
  previewCacheSize,
  setImageResizer,
} from '../src/preview'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'genoffice-preview-'))
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FAKE_OUT = Buffer.from('encoded-png-bytes')

afterEach(() => {
  setImageResizer(null)
  clearPreviewCache()
})

describe('generatePreview without a resizer installed', () => {
  it('reports unsupported instead of fabricating a thumbnail', async () => {
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    expect(await generatePreview(file)).toEqual({ ok: false, reason: 'unsupported' })
  })

  it('reports unsupported even for an image extension it knows', async () => {
    const file = join(tempDir(), 'photo.jpeg')
    writeFileSync(file, PNG)
    expect((await generatePreview(file)).reason).toBe('unsupported')
  })
})

describe('generatePreview with a resizer installed', () => {
  it('returns a PNG data URL', async () => {
    setImageResizer(async () => FAKE_OUT)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    const result = await generatePreview(file)
    expect(result.ok).toBe(true)
    expect(result.mime).toBe('image/png')
    expect(result.dataUrl).toBe(`data:image/png;base64,${FAKE_OUT.toString('base64')}`)
  })

  it('reports the encoded size', async () => {
    setImageResizer(async () => FAKE_OUT)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    expect((await generatePreview(file)).size).toBe(FAKE_OUT.length)
  })

  it('passes the requested max dimension to the resizer', async () => {
    const seen: number[] = []
    setImageResizer(async (_bytes, size) => {
      seen.push(size)
      return FAKE_OUT
    })
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file, { size: 64 })
    expect(seen).toEqual([64])
  })

  it('defaults the max dimension to 128', async () => {
    const seen: number[] = []
    setImageResizer(async (_bytes, size) => {
      seen.push(size)
      return FAKE_OUT
    })
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file)
    expect(seen).toEqual([128])
  })

  it('passes the raw file bytes to the resizer', async () => {
    let received: Buffer | undefined
    setImageResizer(async (bytes) => {
      received = bytes
      return FAKE_OUT
    })
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file)
    expect(received).toEqual(PNG)
  })

  it('reports unsupported for an unknown extension without calling the resizer', async () => {
    const resizer = vi.fn(async () => FAKE_OUT)
    setImageResizer(resizer)
    const file = join(tempDir(), 'archive.zip')
    writeFileSync(file, 'x')
    expect((await generatePreview(file)).reason).toBe('unsupported')
    expect(resizer).not.toHaveBeenCalled()
  })

  it('reports unsupported when the resizer returns null', async () => {
    setImageResizer(async () => null)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    expect((await generatePreview(file)).reason).toBe('unsupported')
  })

  it('reports unsupported when the resizer returns an empty buffer', async () => {
    setImageResizer(async () => Buffer.alloc(0))
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    expect((await generatePreview(file)).reason).toBe('unsupported')
  })

  it('absorbs a throwing resizer instead of failing the handler', async () => {
    setImageResizer(async () => {
      throw new Error('corrupt image')
    })
    const file = join(tempDir(), 'broken.png')
    writeFileSync(file, 'not really a png')
    expect((await generatePreview(file)).reason).toBe('unsupported')
  })

  it('accepts supported extensions case-insensitively', async () => {
    setImageResizer(async () => FAKE_OUT)
    const file = join(tempDir(), 'PHOTO.PNG')
    writeFileSync(file, PNG)
    expect((await generatePreview(file)).ok).toBe(true)
  })

  it('supports jpg, jpeg, gif, webp and bmp', async () => {
    setImageResizer(async () => FAKE_OUT)
    const dir = tempDir()
    for (const ext of ['jpg', 'jpeg', 'gif', 'webp', 'bmp']) {
      const file = join(dir, `img.${ext}`)
      writeFileSync(file, PNG)
      expect((await generatePreview(file)).ok, ext).toBe(true)
    }
  })
})

describe('generatePreview error reasons', () => {
  it('reports missing for a path that does not exist', async () => {
    expect(await generatePreview(join(tempDir(), 'ghost.png'))).toEqual({
      ok: false,
      reason: 'missing',
    })
  })

  it('reports outside-storage when the caller says the path is unmanaged', async () => {
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    expect(await generatePreview(file, { isManaged: false })).toEqual({
      ok: false,
      reason: 'outside-storage',
    })
  })

  it('checks containment before existence', async () => {
    expect(await generatePreview(join(tempDir(), 'ghost.png'), { isManaged: false })).toEqual({
      ok: false,
      reason: 'outside-storage',
    })
  })
})

describe('preview cache', () => {
  it('serves a repeated request from cache without re-encoding', async () => {
    const resizer = vi.fn(async () => FAKE_OUT)
    setImageResizer(resizer)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file)
    await generatePreview(file)
    expect(resizer).toHaveBeenCalledTimes(1)
  })

  it('caches per requested size, so a repeated size hits without re-encoding', async () => {
    const resizer = vi.fn(async () => FAKE_OUT)
    setImageResizer(resizer)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file, { size: 64 })
    await generatePreview(file, { size: 64 })
    expect(resizer).toHaveBeenCalledTimes(1)
  })

  it('misses the cache when the file content changed', async () => {
    const resizer = vi.fn(async () => FAKE_OUT)
    setImageResizer(resizer)
    const dir = tempDir()
    const file = join(dir, 'photo.png')
    writeFileSync(file, Buffer.concat([PNG, Buffer.from('v1')]))
    await generatePreview(file)
    writeFileSync(file, Buffer.concat([PNG, Buffer.from('v2-longer')]))
    await generatePreview(file)
    expect(resizer).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failure', async () => {
    const resizer = vi.fn(async () => null)
    setImageResizer(resizer)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file)
    await generatePreview(file)
    expect(resizer).toHaveBeenCalledTimes(2)
    expect(previewCacheSize()).toBe(0)
  })

  it('clearPreviewCache empties the cache', async () => {
    setImageResizer(async () => FAKE_OUT)
    const file = join(tempDir(), 'photo.png')
    writeFileSync(file, PNG)
    await generatePreview(file)
    expect(previewCacheSize()).toBe(1)
    clearPreviewCache()
    expect(previewCacheSize()).toBe(0)
  })

  it('evicts past the cache cap so a large folder cannot grow the heap', async () => {
    setImageResizer(async () => FAKE_OUT)
    const dir = tempDir()
    for (let i = 0; i < 210; i += 1) {
      const file = join(dir, `img-${i}.png`)
      writeFileSync(file, Buffer.concat([PNG, Buffer.from(String(i))]))
      await generatePreview(file)
    }
    expect(previewCacheSize()).toBeLessThanOrEqual(200)
  })
})
