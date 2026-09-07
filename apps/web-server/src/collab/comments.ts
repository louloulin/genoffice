/**
 * collab/comments — Document comment threads.
 */

import { registerHandle } from '../common/registry.js'
import { DOC_COMMENTS } from './state.js'

export function registerCommentsHandlers(): void {
  registerHandle('comments:list', (_event: unknown, args: unknown) => {
    const { docId } = args as { docId: string }
    return DOC_COMMENTS.get(docId) || []
  })

  registerHandle('comments:add', (_event: unknown, args: unknown) => {
    const { docId, userId, userName, content, selection } = args as {
      docId: string
      userId: string
      userName: string
      content: string
      selection?: { start: number; end: number; text: string }
    }

    if (!DOC_COMMENTS.has(docId)) {
      DOC_COMMENTS.set(docId, [])
    }

    const comments = DOC_COMMENTS.get(docId)!
    const commentId = `comment-${Date.now()}`

    comments.push({
      id: commentId,
      userId,
      userName,
      content,
      timestamp: Date.now(),
      resolved: false,
      replies: [],
      selection,
    })

    return { ok: true, commentId }
  })

  registerHandle('comments:reply', (_event: unknown, args: unknown) => {
    const { docId, commentId, userId, userName, content } = args as {
      docId: string
      commentId: string
      userId: string
      userName: string
      content: string
    }

    const comments = DOC_COMMENTS.get(docId)
    if (!comments) return { ok: false, error: 'Document not found' }

    const comment = comments.find(c => c.id === commentId)
    if (!comment) return { ok: false, error: 'Comment not found' }

    const replyId = `reply-${Date.now()}`
    comment.replies.push({
      id: replyId,
      userId,
      userName,
      content,
      timestamp: Date.now(),
    })

    return { ok: true, replyId }
  })

  registerHandle('comments:resolve', (_event: unknown, args: unknown) => {
    const { docId, commentId } = args as { docId: string; commentId: string }
    const comments = DOC_COMMENTS.get(docId)
    if (!comments) return { ok: false, error: 'Document not found' }

    const comment = comments.find(c => c.id === commentId)
    if (!comment) return { ok: false, error: 'Comment not found' }

    comment.resolved = true
    return { ok: true }
  })

  registerHandle('comments:delete', (_event: unknown, args: unknown) => {
    const { docId, commentId } = args as { docId: string; commentId: string }
    const comments = DOC_COMMENTS.get(docId)
    if (!comments) return { ok: false, error: 'Document not found' }

    const index = comments.findIndex(c => c.id === commentId)
    if (index === -1) return { ok: false, error: 'Comment not found' }

    comments.splice(index, 1)
    return { ok: true }
  })
}
