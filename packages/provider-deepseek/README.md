# `@genoffice/provider-deepseek`

> DeepSeek provider plugin for [GenOffice](https://genoffice.app) — implements
> `AiProviderPlugin` via the openai-compatible factory.

## Install

```sh
npm install @genoffice/provider-deepseek @genoffice/provider-openai-compatible
```

## Wire

```ts
import { createDeepSeekProvider } from '@genoffice/provider-deepseek'

const plugin = createDeepSeekProvider({
  // optional overrides
  // baseUrl: 'https://api.deepseek.com/v1',
  // defaultModel: 'deepseek-chat',
})

registry.register(plugin)
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `https://api.deepseek.com/v1` | Override only if your host proxies. |
| `defaultModel` | `deepseek-chat` | Picker default. |
| `models` | ['deepseek-chat', 'deepseek-reasoner'] | Set in the picker. |

## Models

- `deepseek-chat`
- `deepseek-reasoner`

## Authentication

Set the provider's API key via the picker (`sk-…` placeholder).
The plugin sends `Authorization: Bearer <key>` to `https://api.deepseek.com/v1`.

## License

Apache-2.0 — see `LICENSE` in the monorepo root.
