export { parseFileToText, type ParsedFile, type ParsedFileKind } from './parse'
export { docToText } from './doc'
export { docxToText } from './docx'
export { pptToText } from './ppt'
export { pptxToText } from './pptx'
export { xlsxToText } from './xlsx'
export { pdfToText } from './pdf'

// Structural extraction for DOCX (tables + images). Lives next to the
// text-flattening helpers so callers needing one of either reach the
// same import surface.
export {
  extractDocxTables,
  extractDocxImages,
  type ExtractedDocxTable,
  type ExtractedDocxImage,
} from './docx-structure'
