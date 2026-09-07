import { encodeTransportValue } from '@genoffice/ipc-bridge'
import { describe, expect, it } from 'vitest'
import { createWebComposition } from '../src/main.js'

async function call(port: number, channel: string, args: unknown[]) {
  const response = await fetch(`http://127.0.0.1:${port}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    body: JSON.stringify({ args: args.map((arg) => encodeTransportValue(arg)) }),
  })
  return { status: response.status, body: (await response.json()) as { result?: any } }
}

describe('AI HTTP API', () => {
  it('serves successful chat and search through the standalone server', async () => {
    const app = await createWebComposition({
      port: 0,
      aiService: {
        chat: async () => ({ ok: true, content: 'hello' }),
        search: async () => ({
          results: [{ title: 'x', url: 'https://example.com', snippet: 'y' }],
          method: 'test',
        }),
      },
    })
    try {
      expect((await call(app.server.port, 'ai:web-search', ['hello'])).body.result.method).toBe(
        'test',
      )
      expect(
        (
          await call(app.server.port, 'ai:chat', [
            {
              settings: { provider: 'custom', providers: { custom: { apiKey: '', model: '' } } },
              system: '',
              user: '',
            },
          ])
        ).body.result.content,
      ).toBe('hello')
    } finally {
      await app.server.close()
    }
  })
})
