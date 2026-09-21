# `@genoffice/web-sdk`

> 面向 [GenOffice](https://genoffice.app) 的可嵌入编辑器 SDK。
> 三种集成形态：iframe `<script>`（UMD）、npm `import`（ESM/CJS）、或手写 iframe（`buildEmbedUrl`）。

## 安装

```sh
npm install @genoffice/web-sdk
```

或者通过 `<script>` 标签：

```html
<script src="https://cdn.jsdelivr.net/npm/@genoffice/web-sdk/dist/index.umd.js"></script>
<script>/* 此时 window.GenOffice 已经可用 */</script>
```

## 5 分钟快速上手

```ts
import { createEditor } from '@genoffice/web-sdk'

// 1. 签发 JWT（服务端）：
//    POST /api/v1/auth/jwt  { sub: 'user-123' }
//    → { token: 'eyJ…' }

// 2. 把编辑器挂到容器节点：
const editor = createEditor({
  host: 'https://genoffice.app',
  documentId: 'doc_abc',
  app: 'docs',
  jwt: '<short-lived-token>',
  container: '#editor',
  mode: 'edit',
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})

editor.on('ready', () => console.log('编辑器就绪'))
editor.on('saved', ({ version, url }) => console.log('已保存 v', version))
editor.on('dirtyChanged', ({ dirty }) => console.log('脏?', dirty))
editor.on('error', ({ code, message }) => console.error(code, message))

await editor.command('focus')
await editor.command('insertText', { text: 'Hello from the SDK!' })

// 用完后：
editor.destroy()
```

## 集成形态

| 形态 | 适用场景 |
|---|---|
| `createEditor({ container })` | 希望 SDK 全权管理 iframe 生命周期。 |
| `buildEmbedUrl({ … })` | 希望手写 `<iframe>`，把它放进 SSR 模板 / 邮件正文。 |
| `<script src=…>` | 没有构建管线（CMS / 无打包工具的老项目）。 |

## 类型化 API

| 事件 | 触发时机 |
|---|---|
| `ready` | iframe 已启动，可以接收命令。 |
| `saved` | 保存完成（附带 version + URL）。 |
| `dirtyChanged` | 编辑缓冲区变为脏 / 干净。 |
| `selectionChange` | 用户移动了光标 / 选区。 |
| `error` | 可恢复的编辑器错误。 |
| `closed` | 用户关闭了编辑器（返回上一页 / 显式关闭）。 |

| 命令 | 参数 | 结果 |
|---|---|---|
| `setTheme` | `{ theme }` | — |
| `setLang` | `{ lang }` | — |
| `setMode` | `{ mode }` | — |
| `setContent` | `{ text?, html?, immediate? }` | — |
| `getContent` | — | `{ text?, html?, bytes? }` |
| `insertImage` | `{ url, width?, height?, alt? }` | — |
| `insertText` | `{ text }` | — |
| `print` | — | — |
| `focus` | — | — |
| `aiRewrite` | `{ instruction, selection? }` | `{ text }` |
| `aiTranslate` | `{ target, source? }` | `{ text }` |
| `aiSummarize` | `{ length? }` | `{ text }` |

所有命令通过 `postMessage` 双向通信，并在编辑器确认后 resolve。
内置 30 秒硬超时，防止编辑器卡死导致宿主页面挂起。

## postMessage 信封（v1.0）

```ts
type Envelope = {
  v: '1.0',
  dir: 'host→editor' | 'editor→host',
  kind: 'event' | 'command' | 'command-result',
  correlationId?: string,
  payload: unknown,
}
```

`command-result` 始终携带 `correlationId`，宿主页可借此把结果匹配到正在等待的命令，即便同时有多个命令在飞行。

## 安全提示

- **JWT 必须短期有效。** 一旦泄露即意味着编辑权限。请通过 `POST /api/v1/files/:id/jwt` 签发**按会话 + 文件范围**的短 token。
- **宿主 origin。** 嵌入 iframe 会校验入站 `postMessage` 来源是否在服务端配置的 origin 白名单内。务必确认你的 embed origin 已在服务端加入白名单（TODO：发布前预检脚本）。
- **CSP。** 请把 `frame-src https://genoffice.app`（或你的自部署 origin）加入 `Content-Security-Policy`。

## License

Apache-2.0 — 详见 monorepo 根目录的 `LICENSE`。
