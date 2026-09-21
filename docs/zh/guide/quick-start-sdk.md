# 快速上手：SDK

`@genoffice/web-sdk` 把 iframe 包装成带类型化事件与命令的 handle。

## 安装

```sh
npm install @genoffice/web-sdk
```

## 挂载

```ts
import { createEditor } from '@genoffice/web-sdk'

const editor = createEditor({
  host: 'https://genoffice.app',   // 或你自部署的 origin
  documentId: 'doc_abc',
  app: 'docs',
  jwt: '<token-from-/api/v1/auth/jwt>',
  container: '#editor',
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})

editor.on('ready', () => console.log('编辑器就绪'))
editor.on('saved', ({ version }) => console.log('已保存 v', version))
editor.on('dirtyChanged', ({ dirty }) => console.log('脏:', dirty))
editor.on('error', ({ code, message }) => console.error(code, message))
```

## 发送命令

```ts
await editor.command('focus')
await editor.command('insertText', { text: 'Hello!' })
await editor.command('aiRewrite', { instruction: '翻译成英文' })
```

## 销毁

```ts
editor.destroy()
```

## 直接用 UMD

没有打包工具的项目：

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>
  const editor = GenOffice.createEditor({ /* … */ })
</script>
```

## API 参考

完整的事件 / 命令清单：[SDK 参考](/zh/api/sdk-typescript)。

## 示例

- [`examples/embed-basic/`](https://github.com/genspark-ai/genoffice/tree/main/examples/embed-basic/) — 纯 HTML + UMD。
- `examples/embed-react/` — React 组件。
- `examples/embed-vue/` — Vue 3 组件。
