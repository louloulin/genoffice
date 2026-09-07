/// Signature payload contracts. These live with the service rather than in an
/// app so both the Electron main process and the standalone Web server validate
/// exactly the same shapes.

export interface SignatureStrokes {
  /** flat [x0, y0, x1, y1, ...] polylines in signature-local coordinates */
  paths: number[][]
  width: number
  height: number
}

/** Confirmed signature awaiting placement: hand strokes (Ink) or a bitmap (Stamp) */
export type SignatureData =
  | ({ kind: 'strokes' } & SignatureStrokes)
  | {
      kind: 'image'
      /** base64 PNG, without the data: prefix */
      image: string
      width: number
      height: number
    }

/** A reusable signature persisted outside any single document */
export interface SavedSignature {
  id: string
  createdAt: number
  data: SignatureData
}
