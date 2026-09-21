# SDK Reference — `@genoffice/web-sdk`

TypeScript surface for embedded editors.

## `createEditor(options)`

```ts
function createEditor(options: CreateEditorOptions): EditorHandle
```

| Field | Type | Notes |
|---|---|---|
| `documentId` | `string` | The `:docId` segment. |
| `app` | `'docs' \| 'sheets' \| 'slides' \| 'pdf' \| 'markdown' \| 'html'` | Which editor loads. |
| `jwt` | `string` | Short-lived token. |
| `host` | `string` | GenOffice origin. |
| `container` | `string \| HTMLElement` | CSS selector or DOM element. |
| `url` | `string` | Pre-built embed URL (alternative to `container`). |
| `skipIframe` | `boolean` | Caller manages the iframe. |
| `mode` | `'edit' \| 'view' \| 'comment'` | Default `edit`. |
| `theme` | `'light' \| 'dark' \| 'auto'` | Default `auto`. |
| `lang` | `'zh-CN' \| 'en-US' \| 'ja-JP'` | Default `en-US`. |
| `toolbar` | `'full' \| 'minimal' \| 'none'` | Default `full`. |
| `features` | `Record<string, boolean \| string \| number>` | Pass-through flags (`feat.X`). |

## Events

```ts
editor.on('ready',           () => {})
editor.on('saved',           ({ version, url, bytes }) => {})
editor.on('dirtyChanged',    ({ dirty }) => {})
editor.on('selectionChange', ({ range }) => {})
editor.on('error',           ({ code, message }) => {})
editor.on('closed',          () => {})
```

## Commands

```ts
await editor.command('setTheme',    { theme: 'dark' })
await editor.command('setContent',  { text: '…' })
await editor.command('getContent')
await editor.command('insertImage',  { url, width, height, alt })
await editor.command('insertText',   { text })
await editor.command('print')
await editor.command('focus')
await editor.command('aiRewrite',   { instruction })
await editor.command('aiTranslate',  { target: 'en' })
await editor.command('aiSummarize',  { length: 'short' })
```

Each command round-trips via `postMessage` with a `correlationId` and
times out after 30 s.

## Standalone URL builder

```ts
import { buildEmbedUrl } from '@genoffice/web-sdk'

const url = buildEmbedUrl({
  host: 'https://genoffice.app',
  documentId: 'doc_abc',
  app: 'docs',
  token: '<jwt>',
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})
```

Useful when the host page wants to render the iframe itself (SSR,
email, etc.).

## UMD global

When loaded via `<script src="…/index.umd.js">`, the SDK exposes
`window.GenOffice`:

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>
  const editor = GenOffice.createEditor({ /* … */ })
</script>
```
