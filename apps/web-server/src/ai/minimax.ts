/**
 * ai/minimax — Minimal MiniMax-M3 client preserved from the monolith.
 *
 * Phase 1.3 (LUM-555) will retire this in favor of `@genoffice/ai-provider`
 * and replace the silent fallback with structured error codes. Until then,
 * the standalone client is kept so chat / stream paths remain functional.
 */

const MINIMAX_API_URL = 'https://api.minimax.chat/v1'

export interface MiniMaxMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface MiniMaxResponse {
  id: string
  choices: Array<{
    message: { role: string; content: string }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

export async function callMiniMax(
  apiKey: string,
  messages: MiniMaxMessage[],
  model = 'MiniMax-M3',
  stream = false,
): Promise<{ content: string; id: string; usage?: MiniMaxResponse['usage'] }> {
  if (!apiKey) {
    throw new Error('MiniMax API key not configured')
  }

  const response = await fetch(`${MINIMAX_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream,
      max_tokens: 2048,
      temperature: 0.7,
    }),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`MiniMax API error: ${response.status} - ${error}`)
  }

  const data = (await response.json()) as MiniMaxResponse
  return {
    content: data.choices[0]?.message?.content || '',
    id: data.id,
    usage: data.usage,
  }
}

/**
 * Placeholder fallback response used when MINIMAX_API_KEY is missing.
 *
 * NOTE: This is preserved verbatim from the original monolith. LUM-555 will
 * replace it with a structured error code so callers can detect the
 * misconfiguration.
 */
export function generateAIResponse(message: string): string {
  if (!message) return '请输入内容'
  return `这是 AI 助手的回复。您发送的消息是: "${message}"。\n\n我可以帮助您:\n1. 编辑和格式化文档\n2. 创建表格和幻灯片\n3. 回答问题和提供建议\n4. 搜索和整理信息\n\n请告诉我您需要什么帮助?`
}
