# @genoffice/provider-gemini

Google Gemini provider plugin for [GenOffice](https://genoffice.app).
Implements the [`AiProviderPlugin`](https://genoffice.app/docs/api/provider-plugin) contract from `@genoffice/ai-provider`.

## Install

```sh
npm install @genoffice/provider-gemini
```

## Models shipped

- `gemini-2.5-pro`
- `gemini-2.0-flash` (default)
- `gemini-1.5-pro`
- `gemini-1.5-flash`

## Usage

```ts
import gemini from '@genoffice/provider-gemini'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

getDefaultProviderRegistry().register(gemini)
```

## License

Apache-2.0
