# `@genoffice/provider-kimi`

> Moonshot Kimi provider plugin for [GenOffice](https://genoffice.app) — implements
> `AiProviderPlugin` via the openai-compatible factory.

## Install

```sh
npm install @genoffice/provider-kimi @genoffice/provider-openai-compatible
```

## Wire

```ts
import { createKimiProvider } from '@genoffice/provider-kimi'

const plugin = createKimiProvider({
  // optional overrides
  // baseUrl: 'https://api.deepseek.com/v1',
  // defaultModel: 'moonshot-v1-8k',
})

registry.register(plugin)
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `https://api.moonshot.cn/v1` | Override only if your host proxies. |
| `defaultModel` | `moonshot-v1-8k` | Picker default. |
| `models` | ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'] | Set in the picker. |

## Models

- `moonshot-v1-8k`
- `moonshot-v1-32k`
- `moonshot-v1-128k`

## Authentication

Set the provider's API key via the picker (`sk-…` placeholder).
The plugin sends `Authorization: Bearer <key>` to `https://api.moonshot.cn/v1`.

## License

Apache-2.0 — see `LICENSE` in the monorepo root.
