# SDK 参考 — `@genoffice/web-sdk`

面向嵌入编辑器的 TypeScript 接口面。

## `createEditor(options)`

```ts
function createEditor(options: CreateEditorOptions): EditorHandle
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `documentId` | `string` | URL 里的 `:docId` 段。 |
| `app` | `'docs' \| 'sheets' \| 'slides' \| 'pdf' \| 'markdown' \| 'html'` | 加载哪个编辑器。 |
| `jwt` | `string` | 短期 token。 |
| `host` | `string` | GenOffice origin。 |
| `container` | `string \| HTMLElement` | CSS 选择器或 DOM 元素。 |
| `url` | `string` | 预构建的嵌入 URL（与 `container` 二选一）。 |
| `skipIframe` | `boolean` | 调用方自行管理 iframe。 |
| `mode` | `'edit' \| 'view' \| 'comment'` | 默认 `edit`。 |
| `theme` | `'light' \| 'dark' \| 'auto'` | 默认 `auto`。 |
| `lang` | `'zh-CN' \| 'en-US' \| 'ja-JP'` | 默认 `en-US`。 |
| `toolbar` | `'full' \| 'minimal' \| 'none'` | 默认 `full`。 |
| `features` | `Record<string, boolean \| string \| number>` | 透传特性开关（`feat.X`）。 |

## 事件

```ts
editor.on('ready',           () => {})
editor.on('saved',           ({ version, url, bytes }) => {})
editor.on('dirtyChanged',    ({ dirty }) => {})
editor.on('selectionChange', ({ range }) => {})
editor.on('error',           ({ code, message }) => {})
editor.on('closed',          () => {})
```

## 命令

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

每条命令通过 `postMessage` 双向通信，带 `correlationId`，30 秒超时。

## 独立 URL 构建器

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

适用于宿主页面想自己渲染 iframe 的场景（SSR / 邮件正文等）。

## UMD 全局变量

通过 `<script src="…/index.umd.js">` 加载时，SDK 会暴露 `window.GenOffice`：

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>
  const editor = GenOffice.createEditor({ /* … */ })
</script>
```
