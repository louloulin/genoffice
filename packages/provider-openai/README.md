# @genoffice/provider-openai

OpenAI provider plugin for [GenOffice](https://genoffice.app).
Implements the [`AiProviderPlugin`](https://genoffice.app/docs/api/provider-plugin) contract from `@genoffice/ai-provider`.

## Install

```sh
npm install @genoffice/provider-openai
```

## Models shipped

- `gpt-4o`
- `gpt-4o-mini` (default)
- `gpt-4-turbo`
- `gpt-3.5-turbo`

## Usage

```ts
import openai from '@genoffice/provider-openai'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

getDefaultProviderRegistry().register(openai)
```

## License

Apache-2.0
