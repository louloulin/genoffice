/// Node-safe slice of the PDF export/print path: font coverage probing and
/// font subsetting. Extracted from apps/pdf/src/main so the standalone Web
/// server can serve these capabilities without importing Electron.

export { fontCoversText } from './font-cmap.js'
export { identityCffCharset, subsetTtf } from './font-subset.js'
export { hbSubsetWasmPath } from './wasm-path.js'
