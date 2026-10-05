import type { ParsedDoc, ParseExtras } from '@genoffice/docx-engine'

export type ParsedDocResult = ParsedDoc & { extras: ParseExtras }

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: ParsedDocResult) => void; reject: (e: Error) => void }>()

function failAllPending(error: string): void {
  for (const entry of pending.values()) entry.reject(new Error(error))
  pending.clear()
}

function parseWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data
    if (msg.type === 'parsed') {
      pending.get(msg.id)?.resolve(msg.parsed as ParsedDocResult)
      pending.delete(msg.id)
    } else if (msg.type === 'parse-error') {
      pending.get(msg.id)?.reject(new Error(msg.error))
      pending.delete(msg.id)
    } else if (msg.type === 'altchunk-convert') {
      // Forward to the renderer's desktop bridge — the same converter the
      // in-window parser used before parsing moved into this worker.
      window.desktop
        .convertAltChunkHtml(msg.html)
        .then((bytes) => {
          worker!.postMessage({
            type: 'altchunk-result',
            callId: msg.callId,
            bytes: bytes ? bytes.slice().buffer : null,
          })
        })
        .catch(() => {
          worker!.postMessage({ type: 'altchunk-result', callId: msg.callId, bytes: null })
        })
    }
  })
  worker.addEventListener('error', () => failAllPending('parse worker crashed'))
  worker.addEventListener('messageerror', () => failAllPending('parse worker message deserialization failed'))
  return worker
}

/**
 * Worker-backed parseDocx: same signature and contract as the engine's
 * `parseDocx`, but inflate+XML work runs off the main thread. The input is
 * copied, not transferred — callers keep using their view of the buffer.
 */
export function parseDocxWorker(
  bytes: Uint8Array,
  options: { expandAltChunks?: boolean } = {},
): Promise<ParsedDocResult> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    parseWorker().postMessage({ type: 'parse', id, bytes: bytes.slice().buffer, options })
  })
}
