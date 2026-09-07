import { join } from 'node:path'
import { addSignature, loadSignatures, removeSignature, saveSignatures } from './signature-store.js'
import type { SavedSignature, SignatureData } from './signature-types.js'

/**
 * Saved signatures for the standalone Web server. The desktop app keeps this
 * file in Electron's userData; the server keeps it under its own data root.
 * Read-modify-writes are serialized because several browser tabs share one file,
 * exactly like several pdf windows do on the desktop.
 */
export class SignatureService {
  private readonly filePath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dataDir: string, fileName = 'pdf-signatures.json') {
    this.filePath = join(dataDir, fileName)
  }

  list(): Promise<SavedSignature[]> {
    return this.serialize((list) => list)
  }

  add(data: SignatureData): Promise<SavedSignature[]> {
    return this.serialize(async (list) => {
      const next = addSignature(list, data)
      await saveSignatures(this.filePath, next)
      return next
    })
  }

  remove(id: string): Promise<SavedSignature[]> {
    return this.serialize(async (list) => {
      const next = removeSignature(list, id)
      if (next.length !== list.length) await saveSignatures(this.filePath, next)
      return next
    })
  }

  private serialize(
    operation: (list: SavedSignature[]) => SavedSignature[] | Promise<SavedSignature[]>,
  ): Promise<SavedSignature[]> {
    const next = this.queue
      .catch(() => undefined)
      .then(async () => operation(await loadSignatures(this.filePath)))
    this.queue = next
    return next
  }
}
