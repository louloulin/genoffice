/**
 * Vite/rollup-style raw text imports — the web-server pulls in pptx-ops
 * which uses `?raw` imports for markdown op guides.  The bundler (esbuild)
 * handles these at build time; tsc needs a matching ambient declaration.
 */
declare module '*.md?raw' {
  const text: string
  export default text
}
