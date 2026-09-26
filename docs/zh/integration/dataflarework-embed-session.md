# 嵌入会话(一次调用)

`openEmbedSession()` 一次调用就把嵌入式编辑器需要的全部东西准备好:文件级
JWT、握手 nonce、iframe URL。不要再手工拼接握手流程。

```ts
import { createEditor } from '@genoffice/web-sdk'
import { openEmbedSession } from '@genoffice/web-sdk/file/embed'

const session = await openEmbedSession({
  baseUrl: '/office-engine',
  documentId: knowledgeId,
  bearer: () => localStorage.getItem('genoffice-jwt') ?? '',
})

const editor = createEditor({
  host: window.location.origin,
  documentId: knowledgeId,
  app: 'docs',
  jwt: session.jwt,
  container: '#editor',
  // autoRelease 默认 true → createEditor 在 destroy() 时释放 nonce
  sessionBinding: { sessionId: session.sessionId, nonce: session.nonce },
})
```

这就是全部接入代码。下面是你出问题时需要知道的细节。

## 这次调用做了什么

四步,顺序固定。每一步都复用已有的能力客户端,不新造 HTTP 客户端。

| # | 请求 | Scope | 返回 |
|---|---|---|---|
| 1 | `POST /api/v1/files/:id/jwt` | `files:read` | `{ token, exp, ttlSeconds, oneTime, jti? }` |
| 2 | `POST /api/v1/embed/nonce` | `files:read` | `{ sessionId, nonce, expiresAt, ttlMs }` |
| 3 | `POST /api/v1/embed/verify-nonce` | `files:read` | `{ valid: true }` 或 `{ valid: false, reason }` |
| 4 | *(本地)* `buildDataflareEmbedUrl(...)` | — | iframe URL |

第 3 步可以用 `verifyNonce: false` 跳过。**校验不消费 nonce**——只有 `DELETE`
才会逐出,所以先校验再挂载是安全的。建议保持开启:它把一次失败的握手变成
立即的本地报错,而不是一个白屏的 iframe。

`baseUrl` 必须与 iframe 将要加载的 origin 一致。两者不一致会丢掉
`auth_token` cookie,bridge 立刻 401。

## `autoRelease` 的相互影响

这是最容易踩的一点。`createEditor` **默认**在你调用 `destroy()` 时释放
服务端的 nonce 会话,因为 `sessionBinding.autoRelease` 默认为 `true`。

| 你的用法 | 谁负责释放 | `cleanup()` 返回 |
|---|---|---|
| 传了 `sessionBinding`,`autoRelease` 省略或 `true`(默认) | `createEditor` 在 `destroy()` 时 | `{ released: false }` —— 无害 |
| `sessionBinding: { …, autoRelease: false }` | 你,通过 `session.cleanup()` | `{ released: true }`(首次) |
| 你自己挂 `<iframe>`,不用 `createEditor` | 你,通过 `session.cleanup()` | `{ released: true }`(首次) |

`cleanup()` 幂等且 best-effort:重复调用共享同一个 Promise,只发一次
`DELETE`;传输失败时 resolve 成 `{ released: false }` 而不抛错。所以即使
在默认场景下多调一次也是安全的,只是拿到 `false`。

注意两个生命周期**互不相关**:释放 nonce 会话不会吊销 JWT;而
`oneTime: true` 的 JWT 是被**服务端**在首次校验时吊销的。重新挂载无论
如何都要重新调一次 `openEmbedSession()`。

## 错误与重试

`openEmbedSession` 抛出 `RequestError`,带 `.code`:

| `code` | 触发 | 可重试 |
|---|---|---|
| `INVALID_ARGUMENT` | `baseUrl` / `documentId` 缺失或为空 | 否——改调用参数 |
| `UNAUTHENTICATED` | 任一 mint 返回 401 | 否——刷新 bearer 后重调 |
| `FORBIDDEN` | 403,bearer 缺 `files:read` | 否——补 scope 后重调 |
| `NETWORK` | 传输失败 | **是** |
| `INTERNAL` | 5xx | **是** |
| `EMBED_NONCE_INVALID` | `verify-nonce` 返回 `valid: false` | **否**——nonce 已失效 |

`isRetryable(code)` 编码了最后一列,调用方不必自己硬编码这张表:

```ts
import { isRetryable } from '@genoffice/web-sdk/file/embed'

try {
  session = await openEmbedSession(opts)
} catch (err) {
  if (err.code && isRetryable(err.code)) { /* 退避后重试 */ }
  throw err
}
```

校验失败时,函数会**先释放刚刚 mint 出来的会话**再抛错,所以一次被篡改的
握手不会在服务端 LRU 里留下一个存活整个 TTL 的 nonce。

## 参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | — | **必填**;尾部斜杠会被去掉 |
| `documentId` | — | **必填**;同时是 JWT 的 subject |
| `app` | `'docs'` | `docs` / `sheets` / `slides` / `pdf` / `markdown` / `html` |
| `bearer` | — | 字符串,或 `() => string \| Promise<string>` |
| `fileId` | `documentId` | 文档 id 与存储文件 id 不一致时使用 |
| `ttlSeconds` | 服务端(`3600`) | 30 … 86400;本地校验,越界不发请求 |
| `oneTime` | `false` | 一次性 JWT,首次校验即吊销 |
| `nonceTtlMs` | 服务端(`300_000`) | 服务端上限 1 小时 |
| `readonly` / `locale` / `theme` | — | 透传到 URL(`readonly` / `lang` / `theme`) |
| `verifyNonce` | `true` | 第 3 步的往返校验 |
| `fetch` / `timeoutMs` / `signal` | — | 通用请求开关 |
| `buildUrl` | `buildDataflareEmbedUrl` | 整体替换 URL 构造器 |

只有 `app`、`readonly`、`locale`、`theme` 会进入 URL,其余参数只用于选择或
认证这次会话。

## 自己挂载 iframe

如果你不想让 `createEditor` 接管 DOM,可以跳过它——`openEmbedSession` 已经
返回了可用的 URL。`buildDataflareEmbedUrl` 产出:

```
{baseUrl}/apps/{app}/embedded?embed=1&app=…&doc=…&jwt=…&sessionId=…&nonce=…
```

把它交给自己的 `<iframe>`,再针对 `contentWindow` 挂
`installDataflareHostBridge`。此时释放责任完全在你:卸载时调
`await session.cleanup()`。

跨域嵌入仍需在 web-server 上配 `EMBED_FRAME_ANCESTORS`,在宿主上配
`frame-src`。

## 用真实服务器验证

mock 单测抓不到这里的契约漂移。接进宿主之前先跑一次契约门禁:

```bash
npm run verify:sdk
```

参见[SDK 契约验证](./sdk-verification.md),了解探针覆盖什么、以及刻意不
覆盖什么。

## 延伸阅读

- [嵌入会话 API 参考](/zh/api/sdk-embed-session) —— 全部参数、返回类型、
  sub-path 导入
- [SDK 契约验证](./sdk-verification.md) —— 契约门禁
- [JavaScript SDK](/zh/api/sdk-typescript) —— 事件 / 命令全集
- [REST API v1](/zh/api/rest-api) —— 底层端点
