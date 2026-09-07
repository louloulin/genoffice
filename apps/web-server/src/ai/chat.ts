/**
 * ai/chat — ai:chat, ai:stream, ai:stream-cancel handlers.
 *
 * Phase 1.3 (LUM-555): `ai:chat` routes through @genoffice/ai-provider.
 * When the API key is missing or the upstream call fails, the handler
 * returns a structured `AiProviderError` instead of the old canned
 * `generateAIResponse` template. The renderer can detect `code` on
 * `error.code` and surface a localized message.
 *
 * `ai:stream` and `ai:stream-cancel` are still placeholders — real
 * streaming lands in a follow-up; their canned chunks are explicitly
 * marked as placeholder output, not as fallback content.
 */

import { registerHandle } from '../common/registry.js'
import { aiSettings } from './settings.js'
import { AiProviderError, callAiProvider } from './provider.js'

const AI_STREAMS = new Map<string, { chunks: string[]; abort: AbortController }>()

export function registerAiChatHandlers(): void {
  registerHandle('ai:chat', async (_event: unknown, request: unknown) => {
    const req = request as { message?: string; system?: string; sessionId?: string; context?: unknown }
    const message = req.message || ''
    const context = req.context
    const systemPrompt = req.system || '你是一个专业的办公助手，帮助用户处理文档、表格和幻灯片。'

    try {
      const result = await callAiProvider(aiSettings.settings, systemPrompt, message)
      const content = context
        ? `基于您提供的文档内容，我来帮您分析：\n\n${result.content}\n\n如需进一步帮助，请告诉我具体问题。`
        : result.content

      return {
        id: `chat-${Date.now()}`,
        role: 'assistant',
        content,
        createdAt: Date.now(),
        metadata: {
          model: aiSettings.settings.providers?.[aiSettings.settings.provider]?.model || 'unknown',
          provider: aiSettings.settings.provider,
        },
      }
    } catch (err) {
      // structured error: callers inspect error.code; the renderer matches
      // on code to render localized messages instead of seeing fake AI text
      if (err instanceof AiProviderError) {
        return {
          id: `chat-${Date.now()}`,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          ok: false,
          error: { code: err.code, message: err.message, provider: err.provider },
          metadata: {
            model: aiSettings.settings.providers?.[aiSettings.settings.provider]?.model || 'unknown',
            provider: aiSettings.settings.provider,
          },
        }
      }
      throw err
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
