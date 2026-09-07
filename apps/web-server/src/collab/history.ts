/**
 * collab/history — Document version history.
 */

import { registerHandle } from '../common/registry.js'
import { DOC_VERSIONS } from './state.js'

export function registerHistoryHandlers(): void {
  registerHandle('history:versions', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    const docVersions = DOC_VERSIONS.get(docId)
    if (!docVersions) return []
    return docVersions.versions.map(v => ({
      id: v.id,
      timestamp: v.timestamp,
      userId: v.userId,
      message: v.message || '自动保存',
    }))
  })

  registerHandle('history:create-version', (_event: unknown, args: unknown) => {
    const { docId, content, userId, message } = args as {
      docId: string
      content: string
      userId: string
      message?: string
    }

    if (!DOC_VERSIONS.has(docId)) {
      DOC_VERSIONS.set(docId, { docId, versions: [] })
    }

    const docVersions = DOC_VERSIONS.get(docId)!
    const versionId = `v-${Date.now()}`

    docVersions.versions.push({
      id: versionId,
      content,
      timestamp: Date.now(),
      userId,
      message,
    })

    // Keep last 50 versions
    if (docVersions.versions.length > 50) {
      docVersions.versions = docVersions.versions.slice(-50)
    }

    return { ok: true, versionId, timestamp: Date.now() }
  })

  registerHandle('history:get-version', (_event: unknown, args: unknown) => {
    const { docId, versionId } = args as { docId: string; versionId: string }
    const docVersions = DOC_VERSIONS.get(docId)
    if (!docVersions) return null

    const version = docVersions.versions.find(v => v.id === versionId)
    return version || null
  })

  registerHandle('history:restore-version', (_event: unknown, args: unknown) => {
    const { docId, versionId } = args as { docId: string; versionId: string }
    const docVersions = DOC_VERSIONS.get(docId)
    if (!docVersions) return { ok: false, error: 'Document not found' }

    const version = docVersions.versions.find(v => v.id === versionId)
    if (!version) return { ok: false, error: 'Version not found' }

    return { ok: true, content: version.content }
  })
}
