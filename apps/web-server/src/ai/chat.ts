/**
 * ai/chat — ai:chat, ai:stream, ai:stream-cancel handlers.
 *
 * These are the only AI channels that touch the MiniMax API directly. The
 * placeholder `ai:stream` implementation chunks canned messages; the real
 * streaming wire-up lands with LUM-555.
 */

import { registerHandle } from '../common/registry.js'
import { aiSettings } from './settings.js'
import { callMiniMax, generateAIResponse } from './minimax.js'

const AI_STREAMS = new Map<string, { chunks: string[]; abort: AbortController }>()

export function registerAiChatHandlers(): void {
  registerHandle('ai:chat', async (_event: unknown, request: unknown) => {
    const req = request as { message?: string; system?: string; sessionId?: string; context?: unknown }
    const message = req.message || ''
    const context = req.context

    const minimaxKey = process.env.MINIMAX_API_KEY
    const systemPrompt = req.system || '你是一个专业的办公助手，帮助用户处理文档、表格和幻灯片。'

    try {
      if (minimaxKey) {
        const result = await callMiniMax(
          minimaxKey,
          [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          aiSettings.model || 'MiniMax-M3',
        )

        return {
          id: result.id,
          role: 'assistant',
          content: result.content,
          createdAt: Date.now(),
          metadata: {
            model: aiSettings.model || 'MiniMax-M3',
            provider: 'minimax',
            usage: result.usage,
          },
        }
      }
    } catch (error) {
      console.error('MiniMax API error, falling back to mock:', error)
    }

    let content = generateAIResponse(message)
    if (context) {
      content = `基于您提供的文档内容，我来帮您分析：\n\n${content}\n\n如需进一步帮助，请告诉我具体问题。`
    }

    return {
      id: `chat-${Date.now()}`,
      role: 'assistant',
      content,
      createdAt: Date.now(),
      metadata: {
        model: aiSettings.model || 'mock',
        provider: minimaxKey ? 'minimax' : 'mock',
      },
    }
  })

  registerHandle('ai:stream', async (event: unknown, request: unknown) => {
    const req = request as { message?: string; sessionId?: string }
    const sessionId = req.sessionId || `stream-${Date.now()}`

    const abort = new AbortController()
    AI_STREAMS.set(sessionId, { chunks: [], abort })

    const messages = ['正在处理您的请求', '分析文档结构', '生成内容', '完成']

    const sender = (event as { sender?: { send?: (ch: string, ...args: unknown[]) => void } })?.sender
    if (sender?.send) {
      for (const msg of messages) {
        await new Promise(r => setTimeout(r, 500))
        sender.send('ai:stream-chunk', { sessionId, chunk: msg, done: false })
      }
      sender.send('ai:stream-chunk', { sessionId, chunk: '', done: true })
    }

    AI_STREAMS.delete(sessionId)
    return { id: sessionId }
  })

  registerHandle('ai:stream-cancel', (_event: unknown, sessionId: unknown) => {
    const stream = AI_STREAMS.get(sessionId as string)
    if (stream) {
      stream.abort.abort()
      AI_STREAMS.delete(sessionId as string)
    }
    return { ok: true }
  })
}
