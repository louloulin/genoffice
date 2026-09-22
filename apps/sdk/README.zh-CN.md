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

## 纵深防御握手（v2）

默认的 `createEditor` / `buildEmbedUrl` 使用**纯客户端** nonce 校验（iframe 在 `ready` 里回显 host 生成的 nonce，host SDK 校验匹配）。当 host 页面完全可信时这就够了。

当你希望**服务端**也参与校验——比如把编辑器嵌到不能信任周围 JS 的第三方门户——先调 `createEmbedNonce()` mint 一个 server-bound session，然后把返回的 URL 放进 iframe：

```ts
import { createEmbedNonce, createEditor } from '@genoffice/web-sdk'

const { embedUrl, sessionId, nonce } = await createEmbedNonce({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…', // 必须带 `files:read` scope
  host: 'https://genoffice.app',
  ttlMs: 5 * 60 * 1000, // 可选，默认 5 min
})

// 传给 createEditor({ url }) …
const editor = createEditor({
  documentId: 'doc_abc', app: 'docs', jwt: 'eyJ…', host: 'https://genoffice.app',
  url: embedUrl, container: '#genoffice-mount',
})

// …或者直接放进 <iframe src={embedUrl} />。
```

web-server 会拒绝渲染编辑器，除非 URL 里的 `?nonce=` 与 `?sessionId=` 对应的服务端签发值一致。被篡改或重放的 URL 会拿到 `401 NONCE_SESSION_INVALID` 而不是编辑器 HTML。详见 `sdk1.md §11.26 / §11.27 / §11.28`。

iframe **挂载后**要审计，把 `createEmbedNonce()` 和 `verifyEmbedNonce()` 配对使用：

```ts
import { verifyEmbedNonce } from '@genoffice/web-sdk'

const audit = await verifyEmbedNonce({
  sessionId, nonce, host: 'https://genoffice.app', jwt: 'eyJ…',
})
if (!audit.valid) {
  // iframe 被篡改 / proxy 重放 / session 已过期
  editor.destroy()
  showBanner('编辑器完整性校验失败')
}
```

`verifyEmbedNonce()` 成功返 `{valid:true, expiresAt}`，失败返 `{valid:false, reason:'unknown'|'expired'}`——失败不抛错，只有 HTTP / 网络 / 解析错误才抛。详见 `sdk1.md §11.29`。

iframe 销毁时，调用 `releaseEmbedNonce()` 主动释放服务端 LRU slot：

```ts
import { releaseEmbedNonce } from '@genoffice/web-sdk'

editor.on('closed', () => {
  void releaseEmbedNonce({ sessionId, host: 'https://genoffice.app', jwt: 'eyJ…' })
  // released:true → 服务端已驱逐；released:false → 已不在（与 TTL race）。
  // 只有 HTTP / 网络 / 解析错误才抛。
})
```

详见 `sdk1.md §11.30` 的 DELETE-style endpoint 契约。

### 一体化：`createEditor({ sessionBinding })`（v2 §11.32）

不想手动在 unmount handler 里调 `releaseEmbedNonce()` 时，把 `(sessionId, nonce)` 通过 `sessionBinding` 回传给 `createEditor()`。SDK 会：

1. 把 `?sessionId=…&nonce=…` 拼到 iframe URL（SDK 自己拼 URL 时）；
2. 把 server-minted nonce 当作 handshake nonce（不再生成第二个随机数）；
3. `destroy()` 自动调 `releaseEmbedNonce()`（fire-and-forget——失败被吞掉，5 min TTL 是兜底）。

```ts
import { createEmbedNonce, createEditor } from '@genoffice/web-sdk'

const { embedUrl, sessionId, nonce } = await createEmbedNonce({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…',
  host: 'https://genoffice.app',
})

const editor = createEditor({
  documentId: 'doc_abc',
  app: 'docs',
  jwt: 'eyJ…',
  host: 'https://genoffice.app',
  url: embedUrl,
  container: '#genoffice-mount',
  // 把 mint 出来的 session 传回来；destroy() 自动释放
  sessionBinding: { sessionId, nonce },
})

// 不需要再手动调 releaseEmbedNonce——destroy() 已经做了
editor.destroy()
```

如果想自己管理 release（比如从在 `destroy()` 之后才触发的 page-unload handler 里释放），传 `autoRelease: false`：

```ts
sessionBinding: { sessionId, nonce, autoRelease: false }
```

### 挂载后审计：`verifyEmbedSession()`（v2 §11.32）

`verifyEmbedNonce()` 的同义别名——同样的协议、同样的返回值；换个名字让它在 `mint → mount → audit → release` 这条调用链里读起来更顺：

```ts
import { verifyEmbedSession } from '@genoffice/web-sdk'

editor.on('ready', async () => {
  const audit = await verifyEmbedSession({
    sessionId, nonce, host: 'https://genoffice.app', jwt: 'eyJ…',
  })
  if (!audit.valid) {
    editor.destroy()
    showBanner('编辑器完整性校验失败')
  }
})
```

`verifyEmbedNonce()` 与 `verifyEmbedSession()` 走的是同一个 `POST /api/v1/embed/verify-nonce` endpoint；按调用现场读起来顺手的那个名字选。

| `<script src=…>` | 没有构建管线（CMS / 无打包工具的老项目）。 |

## 多实例（Kestrel M1）

> SDK 2.0 Kestrel 第 1 个里程碑在 `release0919` 落地。详见 `sdk1.md` §B.5.1 #1 / §A.5 #38。

两个改动让单页挂多个编辑器变得很简单：

```ts
// 每个编辑器拿到稳定的 instanceId。host 代码任何地方都能查，
// 不必把 EditorHandle 透传过 props。
const editorA = createEditor({ container: '#left',  documentId: 'doc-1', jwt, host, instanceId: 'split-left' })
const editorB = createEditor({ container: '#right', documentId: 'doc-2', jwt, host, instanceId: 'split-right' })

// host 代码任何位置：
import { getEditor, listEditors } from '@genoffice/web-sdk'

getEditor('split-left').command('setTheme', { theme: 'dark' })
listEditors() // [editorA, editorB] 按创建顺序
```

三条契约：

- **`instanceId` 始终存在**于 `EditorHandle`。不传则 SDK 自动 mint `ed_<base64url>` 格式 id；传字符串则固定。两次 `createEditor()` 用同一 id 会抛带 remediation 的错误 —— 先调 `getEditor(id).destroy()`。
- **`<iframe name>` = `genoffice-{instanceId}`**，postMessage `event.source` 匹配有强 anchor（不再仅依赖 window 等同性）。
- **`destroy()` 自动从 registry 摘除** —— `getEditor(id)` 之后返 `undefined`。

三个新命令（renderer 端落地是 renderer-team 工作，SDK 双向协议已就绪）：

```ts
await editor.command('undo')                                  // 撤销上一次编辑
await editor.command('redo')                                  // 重做
const { length, current } = await editor.command('getUndoStack') // {length: number, current: number}
```

不支持撤销的编辑器（例如 read-only 模式）以 `{ code: 'UNSUPPORTED' }` 拒绝。

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
