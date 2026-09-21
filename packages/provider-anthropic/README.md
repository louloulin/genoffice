# @genoffice/provider-anthropic

Anthropic (Claude) provider plugin for [GenOffice](https://genoffice.app).
Implements the [`AiProviderPlugin`](https://genoffice.app/docs/api/provider-plugin) contract from `@genoffice/ai-provider`.

## Install

```sh
npm install @genoffice/provider-anthropic
```

## Models shipped

- `claude-opus-4-6`
- `claude-sonnet-4-6` (default)
- `claude-haiku-4-5`

## Usage

```ts
import anthropic from '@genoffice/provider-anthropic'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

getDefaultProviderRegistry().register(anthropic)
```

## License

Apache-2.0
