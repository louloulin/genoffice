# Provider 能力矩阵

五家首方 AI provider 的并排对比——它们都作为独立 npm 包发布在 `@genoffice/provider-*` 命名空间下。

## 一览表

| 能力 | Anthropic | OpenAI | Gemini | OpenAI-compat | Ollama |
|---|---|---|---|---|---|
| npm 包 | `@genoffice/provider-anthropic` | `@genoffice/provider-openai` | `@genoffice/provider-gemini` | `@genoffice/provider-openai-compatible` | `@genoffice/provider-ollama` |
| 插件 id | `anthropic` | `openai` | `gemini` | `openai-compatible` | `ollama` |
| API 形态 | 原生 Anthropic Messages | 原生 OpenAI Chat | 原生 Gemini `generateContent` | OpenAI Chat（模板化） | OpenAI Chat（模板化） |
| 单次聊天 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 流式聊天（SSE） | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool / 函数调用 | ✅ | ✅ | ✅ | ✅ | ⚠️ 取决于宿主 |
| 系统提示 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 多轮对话 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 图像输入（视觉） | ✅ | ✅ | ✅ | ⚠️ 取决于宿主 | ⚠️ 取决于宿主 |
| 图像生成 | ❌ | ❌ | ❌（不属范围） | ❌ | ❌ |
| Web 搜索工具 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 自定义 `baseUrl` | ❌ | ❌ | ❌ | ✅ | ✅ |
| 可自部署 | ❌ | ❌ | ❌ | ⚠️ 取决于宿主 | ✅（本机） |
| 需要 API key | ✅ | ✅ | ✅ | ✅ | ❌（无需 key） |

_DeepSeek 与 Kimi 提供的能力与 OpenAI-compat 一致（chat / stream / tool use / 系统提示 / 多轮对话）；默认值与 OpenAI-compat 列相同。DeepSeek 的 `deepseek-reasoner` 还会暴露 reasoning content。_

## 模型清单

| Provider | 默认模型 | 全部模型 |
|---|---|---|
| Anthropic | `claude-sonnet-4-6` | `claude-opus-4-6`、`claude-sonnet-4-6`、`claude-haiku-4-5` |
| OpenAI | `gpt-4o-mini` | `gpt-4o`、`gpt-4o-mini`、`gpt-4-turbo`、`gpt-3.5-turbo` |
| Gemini | `gemini-2.0-flash` | `gemini-2.5-pro`、`gemini-2.0-flash`、`gemini-1.5-pro`、`gemini-1.5-flash` |
| OpenAI-compat | _空（调用方必填）_ | 由宿主提供（通过 `pluginOverrides.models` 设置） |
| Ollama | `llama3.2` | 由宿主提供（通过 `/v1/models` 自动探测） |
| DeepSeek | `deepseek-chat` | `deepseek-chat`、`deepseek-reasoner` |
| Kimi | `moonshot-v1-8k` | `moonshot-v1-8k`、`moonshot-v1-32k`、`moonshot-v1-128k` |
| Qwen | `qwen-plus` | `qwen-max`、`qwen-plus`、`qwen-turbo`、`qwen-long` |
| GLM | `glm-4-plus` | `glm-4-plus`、`glm-4-air`、`glm-4-flash` |
| Doubao | `doubao-pro-32k` | `doubao-pro-32k`、`doubao-pro-128k`、`doubao-lite-32k` |

## API key 占位符

| Provider | picker 里展示的占位符 |
|---|---|
| Anthropic | `sk-ant-…` |
| OpenAI | `sk-…` |
| Gemini | `AIza…` |
| OpenAI-compat | `sk-…`（或供应商特定前缀） |
| Ollama | `not-required` |

## 场景指南

- **长上下文推理、Agent 循环** → Anthropic Claude Opus 4.6（200K+ 上下文，强大的 tool use）。
- **低成本高吞吐聊天** → OpenAI gpt-4o-mini 或 Gemini 2.0 Flash。
- **多模态（图像 + 文本）** → Anthropic / OpenAI / Gemini 都支持视觉输入。
- **本地 / 离线 / 零成本** → Ollama（自动探测已安装模型）。
- **自带 OpenAI 兼容端点** → OpenAI-compatible 工厂。

## 如何注册自定义 provider

两条路：

1. **spread-and-override** 既有兼容插件：
   ```ts
   import compatible from '@genoffice/provider-openai-compatible'
   registry.register({
     ...compatible,
     id: 'together',
     label: 'Together.ai',
     models: ['meta-llama/Llama-3.1-70B-Instruct-Turbo'],
     defaultModel: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
     keyPlaceholder: 'tk-…',
     needsBaseUrl: true,
   })
   ```
2. **自写独立 npm 包**实现 `AiProviderPlugin`，发布到 `@genoffice/provider-<your-provider>`。见 [Provider 插件](/zh/api/provider-plugins)。

## 矩阵变更时

如果新增 provider 或为既有 provider 增加能力，记得更新本页。能力快照在每次 minor 版本 bump 时手动刷新——`API 形态` 行必须如实反映实际传输（`/v1/messages` vs `/v1/chat/completions` vs `:generateContent`）。
