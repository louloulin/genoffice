# `@genoffice/provider-qwen`

> Qwen (DashScope) provider plugin for [GenOffice](https://genoffice.app) — implements
> `AiProviderPlugin` via the openai-compatible factory.

## Install

```sh
npm install @genoffice/provider-qwen @genoffice/provider-openai-compatible
```

## Wire

```ts
import { createQwenProvider } from '@genoffice/provider-qwen'

const plugin = createQwenProvider({
  // optional overrides
  // baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  // defaultModel: 'qwen-plus',
})

registry.register(plugin)
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Override only if your host proxies. |
| `defaultModel` | `qwen-plus` | Picker default. |
| `models` | ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-long'] | Set in the picker. |
| `needsBaseUrl` | `false` | Whether the picker asks for a custom baseUrl. |

## Models

- `qwen-max` (default)
- `qwen-plus`
- `qwen-turbo`
- `qwen-long`

## Authentication

Set the provider's API key via the picker (`sk-…` placeholder).

## License

Apache-2.0 — see `LICENSE` in the monorepo root.
