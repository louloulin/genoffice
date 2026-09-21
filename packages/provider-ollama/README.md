# @genoffice/provider-ollama

Ollama provider plugin for [GenOffice](https://genoffice.app). Talks to a
local Ollama daemon via its OpenAI-compatible `/v1/chat/completions` endpoint
(`Ollama 0.5+`).

## Install

```sh
npm install @genoffice/provider-ollama
```

## Default model

`llama3.2` — override at runtime by passing `{ model: '…' }` in the chat
config, or by spreading the plugin and overriding `defaultModel`.

## Usage

```ts
import ollama from '@genoffice/provider-ollama'
import { getDefaultProviderRegistry } from '@genoffice/ai-provider'

const registry = getDefaultProviderRegistry()
registry.register(ollama)

// Optional: discover installed models at boot.
const installed = await fetch('http://localhost:11434/v1/models').then((r) => r.json())
registry.register({
  ...ollama,
  models: installed.data.map((m) => m.id),
  defaultModel: installed.data[0]?.id ?? 'llama3.2',
})
```

## Configuration

The plugin reads the Ollama endpoint from the chat config's `baseUrl`. By
default it talks to `http://localhost:11434/v1`. Override by spreading
`createOllamaProvider({ baseUrl: 'http://gpu-host.lan:11434/v1' })`.

Ollama doesn't require an API key, so the `validate()` hook accepts any
non-empty string (or you can pass `'ollama'` as a placeholder).

## License

Apache-2.0
