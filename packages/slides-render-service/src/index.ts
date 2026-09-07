/// Node-safe slice of the slides rendering/font path: the bundled font catalog
/// and the media/container sniffers that decide how archive parts render.
/// Extracted from apps/slides/src/main so the standalone Web server can serve
/// these capabilities without importing Electron.

export { FONT_CATALOG, type CatalogFamily, type CatalogFile } from './font-catalog.js'
export { displayMime, sniffImageMime } from './media-mime.js'
export { cfbKind, isCfbHeader } from './cfb-sniff.js'
