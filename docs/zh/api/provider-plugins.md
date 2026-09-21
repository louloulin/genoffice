# Provider 插件

`@genoffice/ai-provider` 提供 registry 接口，让第三方把新的 LLM / 图像 / 搜索 provider 以普通 npm 包的形式接入。

## 接口

```ts
// packages/ai-provider/src/provider-plugin.ts
export interface AiProviderPlugin {
  id: string                 // 'anthropic'、'gemini' 等
  label: string              // 'Anthropic (Claude)'
  models: string[]           // 在 picker 中显示
  defaultModel: string
  keyPlaceholder: string     // 例如 'sk-ant-…'
  needsBaseUrl?: boolean
  validate?(config: { apiKey: string; baseUrl?: string }): void | Promise<void>
  chat(request: AiChatRequest, config: { apiKey: string; baseUrl?: string; model?: string }): Promise<AiChatResponse>
  streamChat(request: AiStreamRequest, config: { apiKey: string; baseUrl?: string; model?: string }): AsyncIterable<AiStreamChunk>
}
```

图像 / 搜索 provider 分别使用 `AiMediaPlugin` 和 `AiSearchPlugin`（形态平行，共用同一 registry）。

## 注册

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

## 配置加载方式

运行时引入插件有两条路：

1. **静态导入**（首方零配置）：
   ```ts
   import { anthropicPlugin } from '@genoffice/provider-anthropic'
   registry.register(anthropicPlugin)
   ```
2. **`genoffice.providers.json`**（第三方）：
   ```json
   {
     "providers": [
       { "name": "@scope/my-plugin", "version": "^1.0.0" }
     ]
   }
   ```
   web-server 启动时读该文件，动态 `import()` 每个模块，并注册默认导出。

## 发布你的插件

1. 新建一个包：`name: '@genoffice/provider-<your-provider>'`、`main: ./dist/index.js`、默认导出实现 `AiProviderPlugin`。
2. 用 provenance 发布到 npm（`npm publish --provenance`）。
3. 把包名加进你的 `genoffice.providers.json` 并重启。

web-server 启动时会逐条日志输出已注册的插件；加载失败只以警告形式出现（启动不会中断）。

## 官方 provider 插件

GenOffice 团队以独立 npm 包形式发布下列 provider，统一在 `@genoffice/provider-*` 命名空间下。每个都实现 `AiProviderPlugin` 契约，并以 npm `beta` tag 发布。

| 包 | 厂商 | 模型 | 说明 |
|---|---|---|---|
| `@genoffice/provider-anthropic` | Anthropic Claude | `claude-opus-4-6`、`claude-sonnet-4-6`、`claude-haiku-4-5` | 原生 Anthropic Messages API。 |
| `@genoffice/provider-openai` | OpenAI | `gpt-4o`、`gpt-4o-mini`、`gpt-4-turbo`、`gpt-3.5-turbo` | 原生 OpenAI Chat Completions API。 |
| `@genoffice/provider-gemini` | Google Gemini | `gemini-2.5-pro`、`gemini-2.0-flash`、`gemini-1.5-pro`、`gemini-1.5-flash` | 原生 Gemini `generateContent` API。 |
| `@genoffice/provider-openai-compatible` | 任意 OpenAI 兼容端点 | 由宿主提供 | spread + override 工厂，覆盖 Together.ai、Fireworks、OpenRouter、Groq、DeepSeek、Kimi、GLM、Qwen、Doubao、vLLM、llama.cpp、LM Studio、Ollama（OpenAI 模式）等。 |
| `@genoffice/provider-ollama` | 本地 Ollama 守护进程 | 由宿主提供 | 默认 `llama3.2`；通过 `/v1/models` 自动探测已安装模型。 |
| `@genoffice/provider-deepseek` | DeepSeek | `deepseek-chat`、`deepseek-reasoner` | OpenAI 兼容端点 `https://api.deepseek.com/v1`；无需自定义 baseUrl。 |
| `@genoffice/provider-kimi` | Moonshot Kimi | `moonshot-v1-8k`、`moonshot-v1-32k`、`moonshot-v1-128k` | OpenAI 兼容端点 `https://api.moonshot.cn/v1`；无需自定义 baseUrl。 |
| `@genoffice/provider-qwen` | Qwen（DashScope）| `qwen-max`、`qwen-plus`、`qwen-turbo`、`qwen-long` | OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`；无需自定义 baseUrl。 |
| `@genoffice/provider-glm` | 智谱 GLM | `glm-4-plus`、`glm-4-air`、`glm-4-flash` | 非标准端点（`/api/paas/v4`）；`needsBaseUrl: true`，宿主必须配置。 |
| `@genoffice/provider-doubao` | 字节豆包 Doubao | `doubao-pro-32k`、`doubao-pro-128k`、`doubao-lite-32k` | 非标准端点（`/api/v3`）；`needsBaseUrl: true`，宿主必须配置。 |

### 示例：通过兼容工厂注册 Together.ai + Groq

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

### 示例：注册本地 Ollama

```ts
import ollama from '@genoffice/provider-ollama'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

const registry = getDefaultProviderRegistry()
registry.register(ollama)
```
