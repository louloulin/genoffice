/// Node-safe slice of the slides rendering/font path: the bundled font catalog,
/// the media/container sniffers that decide how archive parts render, and the
/// image/audio normalizers the renderer needs before it can display a part.
/// Extracted from apps/slides/src/main so the standalone Web server can serve
/// these capabilities without importing Electron.

export { FONT_CATALOG, type CatalogFamily, type CatalogFile } from './font-catalog.js'
export { displayMime, sniffImageMime } from './media-mime.js'
export { cfbKind, isCfbHeader } from './cfb-sniff.js'
export { tiffToPng, type DecodedTiff } from './tiff-decode.js'
export { neutralizeJpegOrientation } from './jpeg-orientation.js'
export { audioSampleFormats, unplayableAudioCodec } from './mp4-audio-sniff.js'
