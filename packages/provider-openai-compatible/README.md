# @genoffice/provider-openai-compatible

Generic OpenAI-compatible provider plugin for [GenOffice](https://genoffice.app).
Wraps any vendor that serves the OpenAI `/v1/chat/completions` endpoint.

## Compatible vendors

Tested against the public docs of:

- **Together.ai** — `https://api.together.xyz/v1`
- **Fireworks AI** — `https://api.fireworks.ai/inference/v1`
- **OpenRouter** — `https://openrouter.ai/api/v1`
- **Groq** — `https://api.groq.com/openai/v1`
- **DeepSeek** — `https://api.deepseek.com/v1`
- **Moonshot Kimi** — `https://api.moonshot.cn/v1`
- **Zhipu GLM** — `https://open.bigmodel.cn/api/paas/v4`
- **Alibaba Qwen DashScope** — `https://dashscope.aliyuncs.com/compatible-mode/v1`
- **Bytedance Doubao** — `https://ark.cn-beijing.volces.com/api/v3`
- **OpenAI-compatible self-hosted**: vLLM, llama.cpp, LM Studio, Ollama (in OpenAI-compat mode)

## Install

```sh
npm install @genoffice/provider-openai-compatible
```

## Usage

```ts
import compatible from '@genoffice/provider-openai-compatible'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

const registry = getDefaultProviderRegistry()

// Each vendor is a different `id` so the registry can hold many at once.
registry.register({
  ...compatible,
  id: 'together',
  label: 'Together.ai',
  models: ['meta-llama/Llama-3.1-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1'],
  defaultModel: 'meta-llama/Llama-3.1-70B-Instruct-Turbo',
  keyPlaceholder: 'tk-…',
  needsBaseUrl: true,
})

registry.register({
  ...compatible,
  id: 'groq',
  label: 'Groq',
  models: ['llama-3.1-70b-versatile', 'mixtral-8x7b-32768'],
  defaultModel: 'llama-3.1-70b-versatile',
  keyPlaceholder: 'gsk_…',
  needsBaseUrl: true,
})
```

The plugin only implements the wire format — `id`, `label`, `models`, and
`defaultModel` are spread in by the host.

## License

Apache-2.0
