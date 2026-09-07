import type { AiChatRequest, AiChatResponse } from '@genoffice/ai-provider'
import { chatForProvider } from '@genoffice/ai-provider'
import { webSearch, type WebSearchResult } from '@genoffice/ai-search'

export interface AiService {
  chat(request: AiChatRequest): Promise<AiChatResponse>
  search(
    query: string,
    maxResults?: number,
  ): Promise<{ results: WebSearchResult[]; method: string; answer?: string; error?: string }>
}

/** Node-safe AI facade for standalone Web composition. Credentials stay in request/config. */
export function createAiService(): AiService {
  return {
    chat: (request) =>
      chatForProvider(
        request.settings.provider,
        request.settings.providers[request.settings.provider],
        request.system,
        request.user,
      ),
    search: (query, maxResults) => webSearch(query, maxResults),
  }
}

export function registerAiHandlers(
  registry: {
    registerHandle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void
  },
  service: AiService,
): void {
  registry.registerHandle('ai:chat', (_event, request: unknown) => {
    if (!request || typeof request !== 'object') throw new Error('ai:chat expects a request')
    return service.chat(request as AiChatRequest)
  })
  registry.registerHandle('ai:web-search', (_event, query: unknown, maxResults?: unknown) => {
    if (typeof query !== 'string' || !query.trim()) throw new Error('ai:web-search expects a query')
    return service.search(query, typeof maxResults === 'number' ? maxResults : undefined)
  })
}
