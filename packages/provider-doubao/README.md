# `@genoffice/provider-doubao`

> ByteDance Doubao provider plugin for [GenOffice](https://genoffice.app) — implements
> `AiProviderPlugin` via the openai-compatible factory.

> **Note**: Doubao's Ark endpoint is `/api/v3` (no `/v1` suffix). The factory appends
> `/v1/chat/completions` to whatever `baseUrl` you set, so configure the picker to use
> `https://ark.cn-beijing.volces.com/api/v3` and the plugin will request
> `…/api/v3/v1/chat/completions` — which works against Ark.

## Install

```sh
npm install @genoffice/provider-doubao @genoffice/provider-openai-compatible
```

## Wire

```ts
import { createDoubaoProvider } from '@genoffice/provider-doubao'

const plugin = createDoubaoProvider({
  // optional overrides
  // baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  // defaultModel: 'doubao-pro-32k',
})

registry.register(plugin)
```

## Configuration

| Field | Default | Notes |
|---|---|---|
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` | Ark `api/v3` endpoint. |
| `defaultModel` | `doubao-pro-32k` | Picker default. |
| `models` | `doubao-pro-32k`, `doubao-pro-128k`, `doubao-lite-32k` | Set in the picker. |
| `needsBaseUrl` | `true` | Whether the picker asks for a custom baseUrl. |

## Models

- `doubao-pro-32k` (default)
- `doubao-pro-128k`
- `doubao-lite-32k`

## Authentication

Set the provider's API key via the picker.

## License

Apache-2.0 — see `LICENSE` in the monorepo root.
