# `@genoffice/provider-glm`

> Zhipu GLM provider plugin for [GenOffice](https://genoffice.app) — implements
> `AiProviderPlugin` via the openai-compatible factory.

> **Note**: `Zhipu GLM`'s endpoint is at `/api/paas/v4` (no `/v1` suffix). The factory appends `/v1/chat/completions` to whatever `baseUrl` you set, so configure the picker to use `https://open.bigmodel.cn/api/paas/v4/v1` (i.e. with the trailing `/v1`) or override `baseUrl` when calling the factory.

## Install

```sh
npm install @genoffice/provider-glm @genoffice/provider-openai-compatible
```

## Wire

```ts
import { createGlmProvider } from '@genoffice/provider-glm'

const plugin = createGlmProvider({
  // optional overrides
  // baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  // defaultModel: 'glm-4-plus',
})

registry.register(plugin)
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `https://open.bigmodel.cn/api/paas/v4` | Override only if your host proxies. |
| `defaultModel` | `glm-4-plus` | Picker default. |
| `models` | ['glm-4-plus', 'glm-4-air', 'glm-4-flash'] | Set in the picker. |
| `needsBaseUrl` | `true` | Whether the picker asks for a custom baseUrl. |

## Models

- `glm-4-plus` (default)
- `glm-4-air`
- `glm-4-flash`

## Authentication

Set the provider's API key via the picker (`…` placeholder).

## License

Apache-2.0 — see `LICENSE` in the monorepo root.
