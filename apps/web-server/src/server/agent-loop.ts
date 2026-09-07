/**
 * server/agent-loop — Agent Loop SSE bridge.
 *
 * Wraps the in-process `generateAgentResponse` so the renderer can stream
 * agent responses without dragging in `@genoffice/agent-core`'s HTTP
 * transport. This is the lightweight inline implementation preserved
 * from the monolith; the full HTTP transport swap lands with Phase 2.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readBody, sendJson } from './http.js'

const ACTIVE_STREAMS = new Map<string, {
  controller: ReadableStreamDefaultController
  aborted: boolean
}>()

/**
 * Placeholder agent response generator. Will be replaced with
 * `@genoffice/agent-core`'s HTTP transport during Phase 2 (per LUM-551 §3).
 */
export function generateAgentResponse(messages: unknown[]): string {
  const lastMsg = messages[messages.length - 1] as { text?: string } | undefined
  const userMessage = lastMsg?.text || 'Hello'

  const responses = [
    `我收到了您的消息: "${userMessage}"。`,
    `正在分析您的请求...`,
    `根据我的理解，您需要帮助处理这个任务。`,
    `我可以帮助您完成文档编辑、表格处理、幻灯片制作等工作。`,
    `请问还有什么其他需要帮助的吗？`,
  ]

  return responses.join(' ')
}

export async function handleAgentStream(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const body = await readBody(request)
    const { requestId, messages, tools } = JSON.parse(body || '{}')

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Request-Id': requestId || '',
    })

    const responseText = generateAgentResponse(messages || [])
    const words = responseText.split(/([\s，。、！？]+)/)
    let delay = 50

    const streamChunk = (type: string, data: Record<string, unknown>) => {
      response.write(`data: ${JSON.stringify({ requestId, type, ...data })}\n\n`)
    }

    const pingInterval = setInterval(() => {
      try { response.write(`data: ${JSON.stringify({ requestId, type: 'ping' })}\n\n`) } catch {}
    }, 30000)

    let wordIndex = 0
    const sendWord = () => {
      if (wordIndex >= words.length) {
        clearInterval(pingInterval)
        response.write(`data: ${JSON.stringify({ requestId, type: 'done', stopReason: 'stop' })}\n\n`)
        response.end()
        return
      }

      streamChunk('delta', { text: words[wordIndex] })
      wordIndex++

      if (wordIndex === Math.floor(words.length / 2) && tools && tools.length > 0) {
        const toolCall = {
          id: `tool-${Date.now()}`,
          name: tools[0].name,
          input: {},
        }
        streamChunk('tool-call', { toolCall })
      }

      setTimeout(sendWord, delay)
    }

    sendWord()

    request.on('close', () => {
      clearInterval(pingInterval)
    })
  } catch (error) {
    sendJson(response, 500, { error: String((error as Error)?.message) })
  }
}
