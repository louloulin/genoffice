/** Compatibility shim: the implementation now lives in @genoffice/pdf-export-service. */
export {
  addSignature,
  isSignatureData,
  loadSignatures,
  MAX_SAVED_SIGNATURES,
  removeSignature,
  sanitizeSignatures,
  saveSignatures,
} from '@genoffice/pdf-export-service'
