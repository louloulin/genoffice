/**
 * Media decoding helpers for the slides media resolver — ports of
 * `apps/slides/src/main/{media-mime,jpeg-orientation,tiff-decode}.ts`.
 *
 * These three are the only `apps/slides/src/main` modules the UI handler layer
 * needs: the desktop `render-helpers.ts` that wraps them drags in harfbuzz wasm
 * and Electron, so it is deliberately NOT ported (web-server made the same cut).
 * Ports rather than imports because a published office-ai tarball must not
 * reach into `apps/` source. Keep them in sync if the originals change.
 *
 * The TIFF path re-encodes to PNG with the shared encoder in `../../png.ts`
 * instead of pngjs (which the original imports): the PNG container is four
 * chunks and a CRC, and pulling a dependency into the package for one image
 * format is the wrong trade.
 */
import UTIF from 'utif2'
import { rgbaToPng } from '../../png'

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  // Metafiles keep their real mime so the renderer's image loader rasterizes them
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false
  return true
}

/** Sniffed mime from magic bytes, or null when the header is unrecognized. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(bytes, [0x42, 0x4d])) return 'image/bmp'
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8))
    return 'image/webp'
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'image/tiff'
  // EMF: record type 1 (EMR_HEADER) + " EMF" signature at offset 40
  if (
    startsWith(bytes, [0x01, 0x00, 0x00, 0x00]) &&
    startsWith(bytes, [0x20, 0x45, 0x4d, 0x46], 40)
  )
    return 'image/x-emf'
  // Placeable WMF
  if (startsWith(bytes, [0xd7, 0xcd, 0xc6, 0x9a])) return 'image/x-wmf'
  return null
}

/**
 * Effective display mime: sniffed container first, then the extension, then PNG.
 * Magic bytes win because legacy converters routinely mislabel media (a PNG
 * preview stored as .emf routed the bytes into the EMF parser and rendered nothing).
 */
export function displayMime(mediaRef: string, bytes: Uint8Array): string {
  const sniffed = sniffImageMime(bytes)
  if (sniffed) return sniffed
  const ext = mediaRef.split('.').pop()?.toLowerCase() ?? ''
  return EXT_MIME[ext] ?? 'image/png'
}

/**
 * Neutralize a JPEG's EXIF Orientation in place (tag 0x0112 -> 1).
 *
 * PowerPoint ignores EXIF orientation and renders the raw pixel grid; Chromium
 * auto-applies it, and a data-URL <img> has no canvas opt-out. Files that
 * combine a rotated pixel grid with an EXIF flag AND a shape-level rot therefore
 * render 90 degrees off. Rewriting the flag byte before serving keeps every
 * consumer on PowerPoint's semantics; the archive keeps the original bytes.
 */
export function neutralizeJpegOrientation(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes
  let off = 2
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return bytes
    const marker = bytes[off + 1]!
    // Start of scan / end: no APP1 past this point
    if (marker === 0xda || marker === 0xd9) return bytes
    const segLen = (bytes[off + 2]! << 8) | bytes[off + 3]!
    if (segLen < 2 || off + 2 + segLen > bytes.length) return bytes
    if (marker === 0xe1) {
      const p = off + 4
      // "Exif\0\0"
      if (
        bytes[p] === 0x45 &&
        bytes[p + 1] === 0x78 &&
        bytes[p + 2] === 0x69 &&
        bytes[p + 3] === 0x66 &&
        bytes[p + 4] === 0x00 &&
        bytes[p + 5] === 0x00
      ) {
        const tiff = p + 6
        const le = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49
        const be = bytes[tiff] === 0x4d && bytes[tiff + 1] === 0x4d
        if (!le && !be) return bytes
        const u16 = (o: number) =>
          le ? bytes[o]! | (bytes[o + 1]! << 8) : (bytes[o]! << 8) | bytes[o + 1]!
        const u32 = (o: number) =>
          le
            ? (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>>
              0
            : ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>>
              0
        const segEnd = off + 2 + segLen
        const ifd0 = tiff + u32(tiff + 4)
        if (ifd0 + 2 > segEnd) return bytes
        const count = u16(ifd0)
        for (let i = 0; i < count; i++) {
          const e = ifd0 + 2 + i * 12
          if (e + 12 > segEnd) return bytes
          if (u16(e) !== 0x0112) continue
          const cur = u16(e + 8)
          if (cur === 1 || cur === 0) return bytes
          const out = new Uint8Array(bytes)
          if (le) {
            out[e + 8] = 1
            out[e + 9] = 0
          } else {
            out[e + 8] = 0
            out[e + 9] = 1
          }
          return out
        }
        return bytes
      }
    }
    off += 2 + segLen
  }
  return bytes
}

export interface DecodedTiff {
  png: Uint8Array
  width: number
  height: number
}

/**
 * Chromium cannot decode TIFF, so a picture embedded as ppt/media/*.tif would
 * render as a blank placeholder. Decode with UTIF (pure JS) and re-encode as PNG
 * for display; the original TIFF bytes stay untouched in the package so saving
 * preserves them byte-for-byte.
 */
export function tiffToPng(bytes: Uint8Array): DecodedTiff | null {
  try {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const ifds = UTIF.decode(buf)
    if (!ifds.length) return null
    // Multi-page/multi-resolution TIFFs: pick the largest page
    let page = ifds[0]!
    for (const ifd of ifds) {
      UTIF.decodeImage(buf, ifd)
      if ((ifd.width || 0) * (ifd.height || 0) > (page.width || 0) * (page.height || 0)) page = ifd
    }
    const width = page.width
    const height = page.height
    if (!width || !height) return null
    return { png: rgbaToPng(width, height, UTIF.toRGBA8(page)), width, height }
  } catch {
    return null
  }
}