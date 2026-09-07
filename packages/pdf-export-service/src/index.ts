/// Node-safe slice of the PDF export/print path: font coverage probing, font
/// subsetting, saved signatures and generated-output naming. Extracted from
/// apps/pdf/src/main so the standalone Web server can serve these capabilities
/// without importing Electron.

export { fontCoversText } from './font-cmap.js'
export { identityCffCharset, subsetTtf } from './font-subset.js'
export { hbSubsetWasmPath } from './wasm-path.js'
export { uniqueGeneratedPdfPath } from './generated-output.js'
export {
  cropPagesBytes,
  extractPagesBytes,
  insertBlankPageBytes,
  insertPdfBytes,
  mergeGrid,
  mergePagesBytes,
  mergePdfBytes,
  replacePagesBytes,
  setPageSizeBytes,
  splitPagesBytes,
  splitPdfBytes,
  type CropFractionsRect,
  type MergePagesOptions,
} from './page-operations.js'
export {
  addSignature,
  isSignatureData,
  loadSignatures,
  MAX_SAVED_SIGNATURES,
  removeSignature,
  sanitizeSignatures,
  saveSignatures,
} from './signature-store.js'
export { SignatureService } from './signature-service.js'
export type { SavedSignature, SignatureData, SignatureStrokes } from './signature-types.js'
