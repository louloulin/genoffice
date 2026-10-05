import { parseDocx, setAltChunkHtmlConverter } from '@genoffice/docx-engine'

// w:altChunk HTML→docx conversion runs in the app's main process (html2docx
// needs a browser window). The worker proxies it through the client that
// spawned it, so documents containing altChunks parse identically here.
let callSeq = 0
const pendingAltChunk = new Map<number, (bytes: Uint8Array | null) => void>()

setAltChunkHtmlConverter(
  (html) =>
    new Promise((resolve) => {
      const callId = ++callSeq
      pendingAltChunk.set(callId, resolve)
      self.postMessage({ type: 'altchunk-convert', callId, html })
    }),
)

type ParseRequest = { type: 'parse'; id: number; bytes: ArrayBuffer; options?: { expandAltChunks?: boolean } }
type AltChunkResult = { type: 'altchunk-result'; callId: number; bytes: ArrayBuffer | null }

self.addEventListener('message', (event: MessageEvent<ParseRequest | AltChunkResult>) => {
  const msg = event.data
  if (msg.type === 'altchunk-result') {
    pendingAltChunk.get(msg.callId)?.(msg.bytes ? new Uint8Array(msg.bytes) : null)
    pendingAltChunk.delete(msg.callId)
    return
  }
  if (msg.type !== 'parse') return
  parseDocx(new Uint8Array(msg.bytes), msg.options)
    .then((parsed) => self.postMessage({ type: 'parsed', id: msg.id, parsed }))
    .catch((err: unknown) =>
      self.postMessage({
        type: 'parse-error',
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
})
