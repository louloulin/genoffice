/**
 * ai/search — ai:web-search + ai:image-search placeholders.
 */

import { registerHandle } from '../common/registry.js'

export function registerAiSearchHandlers(): void {
  registerHandle('ai:web-search', async (_event: unknown, query: unknown, maxResults = 5) => {
    return [
      { title: `${query} - 搜索结果 1`, url: 'https://example.com/1', snippet: '' },
      { title: `${query} - 搜索结果 2`, url: 'https://example.com/2', snippet: '请配置 Tavily API' },
    ].slice(0, maxResults as number)
  })

  registerHandle('ai:image-search', async (_event: unknown, query: unknown, maxResults = 5) => {
    return [
      { url: `https://picsum.photos/200?random=${Date.now()}`, title: `${query} 图片 1` },
      { url: `https://picsum.photos/200?random=${Date.now() + 1}`, title: `${query} 图片 2` },
    ].slice(0, maxResults as number)
  })
}
