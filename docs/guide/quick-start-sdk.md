# Quick Start: SDK

The `@genoffice/web-sdk` package wraps an iframe in a typed handle with
events and commands.

## Install

```sh
npm install @genoffice/web-sdk
```

## Mount

```ts
import { createEditor } from '@genoffice/web-sdk'

const editor = createEditor({
  host: 'https://genoffice.app',   // or your self-hosted origin
  documentId: 'doc_abc',
  app: 'docs',
  jwt: '<token-from-/api/v1/auth/jwt>',
  container: '#editor',
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})

editor.on('ready', () => console.log('editor ready'))
editor.on('saved', ({ version }) => console.log('saved v', version))
editor.on('dirtyChanged', ({ dirty }) => console.log('dirty:', dirty))
editor.on('error', ({ code, message }) => console.error(code, message))
```

## Send commands

```ts
await editor.command('focus')
await editor.command('insertText', { text: 'Hello!' })
await editor.command('aiRewrite', { instruction: 'translate to English' })
```

## Tear down

```ts
editor.destroy()
```

## Build UMD directly

For non-bundler apps:

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>
  const editor = GenOffice.createEditor({ /* … */ })
</script>
```

## API reference

Full event / command surface: [SDK Reference](/api/sdk-typescript).

## Examples

- [`examples/embed-basic/`](https://github.com/genspark-ai/genoffice/tree/main/examples/embed-basic/) — vanilla HTML + UMD.
- `examples/embed-react/` — React component (planned).
- `examples/embed-vue/` — Vue 3 component (planned).
