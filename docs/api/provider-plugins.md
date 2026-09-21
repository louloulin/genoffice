# Provider Plugins

`@genoffice/ai-provider` ships with a registry interface that lets
third parties drop in new LLM / image / search providers as plain npm
packages.

## Interface

```ts
// packages/ai-provider/src/provider-plugin.ts
export interface AiProviderPlugin {
  id: string                 // 'anthropic', 'gemini', …
  label: string              // 'Anthropic (Claude)'
  models: string[]           // surfaced in the picker
  defaultModel: string
  keyPlaceholder: string     // e.g. 'sk-ant-…'
  needsBaseUrl?: boolean
  validate?(config: { apiKey: string; baseUrl?: string }): void | Promise<void>
  chat(request: AiChatRequest, config: { apiKey: string; baseUrl?: string; model?: string }): Promise<AiChatResponse>
  streamChat(request: AiStreamRequest, config: { apiKey: string; baseUrl?: string; model?: string }): AsyncIterable<AiStreamChunk>
}
```

Image / search providers use `AiMediaPlugin` and `AiSearchPlugin`
respectively (parallel shapes, same registry).

## Registering

```ts
import { createProviderRegistry } from '@genoffice/ai-provider'

const registry = createProviderRegistry()
registry.register({
  id: 'my-provider',
  label: 'My Provider',
  models: ['m1', 'm2'],
  defaultModel: 'm1',
  keyPlaceholder: 'sk-…',
  chat: async (req, { apiKey }) => ({ ok: true, content: 'hi' }),
  streamChat: async function* () { yield { requestId: 'r', type: 'done' } },
})
```

## Configuration loaders

Two ways to ship a plugin at runtime:

1. **Static import** (zero-config for first-party):
   ```ts
   import { anthropicPlugin } from '@genoffice/provider-anthropic'
   registry.register(anthropicPlugin)
   ```
2. **`genoffice.providers.json`** (third-party):
   ```json
   {
     "providers": [
       { "name": "@scope/my-plugin", "version": "^1.0.0" }
     ]
   }
   ```
   The web-server reads this file at boot, dynamically imports each
   module, and registers the default export.

## Publishing your plugin

1. Create a package with `name: '@genoffice/provider-<your-provider>'`,
   `main: ./dist/index.js`, and a default export that implements
   `AiProviderPlugin`.
2. Publish to npm with provenance (`npm publish --provenance`).
3. Add the package to your `genoffice.providers.json` and restart.

The web-server logs every registered plugin at boot; failed imports
are surfaced as warnings (the boot does not abort).

## Official provider plugins

The GenOffice team ships the following provider packages as standalone npm
modules under the `@genoffice/provider-*` namespace. Each implements the
`AiProviderPlugin` contract and is published under the `beta` npm tag.

| Package | Vendor | Models | Notes |
|---|---|---|---|
| `@genoffice/provider-anthropic` | Anthropic Claude | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5` | Native Anthropic Messages API. |
| `@genoffice/provider-openai` | OpenAI | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo` | Native OpenAI Chat Completions API. |
| `@genoffice/provider-gemini` | Google Gemini | `gemini-2.5-pro`, `gemini-2.0-flash`, `gemini-1.5-pro`, `gemini-1.5-flash` | Native Gemini `generateContent` API. |
| `@genoffice/provider-openai-compatible` | Any OpenAI-compatible endpoint | host-supplied | Spread-and-override factory for Together.ai, Fireworks, OpenRouter, Groq, DeepSeek, Kimi, GLM, Qwen, Doubao, vLLM, llama.cpp, LM Studio, Ollama (OpenAI mode), etc. |
| `@genoffice/provider-ollama` | Local Ollama daemon | host-supplied | Default `llama3.2`; auto-detects installed models via `/v1/models`. |
| `@genoffice/provider-deepseek` | DeepSeek | `deepseek-chat`, `deepseek-reasoner` | OpenAI-compatible at `https://api.deepseek.com/v1`; no custom baseUrl required. |
| `@genoffice/provider-kimi` | Moonshot Kimi | `moonshot-v1-8k`, `moonshot-v1-32k`, `moonshot-v1-128k` | OpenAI-compatible at `https://api.moonshot.cn/v1`; no custom baseUrl required. |
| `@genoffice/provider-qwen` | Qwen (DashScope) | `qwen-max`, `qwen-plus`, `qwen-turbo`, `qwen-long` | OpenAI-compatible at `https://dashscope.aliyuncs.com/compatible-mode/v1`; no custom baseUrl required. |
| `@genoffice/provider-glm` | Zhipu GLM | `glm-4-plus`, `glm-4-air`, `glm-4-flash` | Non-standard endpoint (`/api/paas/v4`); `needsBaseUrl: true` — host must configure. |
| `@genoffice/provider-doubao` | ByteDance Doubao | `doubao-pro-32k`, `doubao-pro-128k`, `doubao-lite-32k` | Non-standard endpoint (`/api/v3`); `needsBaseUrl: true` — host must configure. |

### Example: register Together.ai + Groq via the compatible factory

```ts
import compatible from '@genoffice/provider-openai-compatible'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

const registry = getDefaultProviderRegistry()

registry.register({
  ...compatible,
  id: 'together',
  label: 'Together.ai',
  models: ['meta-llama/Llama-3.1-70B-Instruct-Turbo'],
  defaultModel: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
  keyPlaceholder: 'tk-…',
  needsBaseUrl: true,
})

registry.register({
  ...compatible,
  id: 'groq',
  label: 'Groq',
  models: ['llama-3.1-70b-versatile'],
  defaultModel: 'llama-3.1-70b-versatile',
  keyPlaceholder: 'gsk_…',
  needsBaseUrl: true,
})
```

### Example: register Ollama (local)

```ts
import ollama from '@genoffice/provider-ollama'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

const registry = getDefaultProviderRegistry()
registry.register(ollama)
```
