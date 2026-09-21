/**
 * Placeholder ambient declaration for the optional pdfjs-dist worker entry.
 *
 * The pdfjs worker bundle is optional — it ships as a side-effect of the
 * `pdfjs-dist` package and is referenced from `pdf.ts` via a triple-slash
 * directive. When the upstream dependency tree is hoisted into a workspace
 * (npm/pnpm/yarn without hoisting), the `.d.ts` next to the JS worker can
 * fall out of the resolve graph and `tsc` will refuse to type-check the
 * project even though runtime behaviour is unaffected.
 *
 * This stub matches the surface pdf.ts actually imports (`pdfjsLib.WorkerMessageHandler`)
 * so `tsc` accepts the reference. Real typings, when the worker is bundled
 * alongside pdfjs-dist, take precedence because the `declare module` here
 * has no body — TypeScript only loads it when nothing better is found.
 */
declare module '*pdfjs-worker*' {
  const handler: unknown
  export { handler }
}

declare module 'pdfjs-dist/build/pdf.worker.mjs' {
  const handler: unknown
  export { handler }
}
