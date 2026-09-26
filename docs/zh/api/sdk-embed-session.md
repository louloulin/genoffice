# 嵌入会话 API

`openEmbedSession()` 及其返回的 `EmbedSession` 参考。

- **引入版本** `@genoffice/web-sdk` 0.9.0-beta.1
- **sub-path** `@genoffice/web-sdk/file/embed`
- **同时从包根导出** `@genoffice/web-sdk`
- **零依赖**

```ts
import { openEmbedSession, isRetryable } from '@genoffice/web-sdk/file/embed'
import type { EmbedSession, EmbedSessionOptions } from '@genoffice/web-sdk/file/embed'
```

推荐用 sub-path 导入:它能把 Dataflare host bridge(以及它的 UMD bundle)
挡在"只想 mint 一个会话"的包之外。

## `openEmbedSession(options): Promise<EmbedSession>`

### `EmbedSessionOptions`

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `baseUrl` | `string` | — | **必填。** web-server 基址,如 `/office-engine`。尾部斜杠会被去掉。 |
| `documentId` | `string` | — | **必填。** 会 trim;空白值本地即拒绝。 |
| `app` | `string` | `'docs'` | 会 trim;空白值回落到 `docs`。 |
| `bearer` | `string \| () => string \| Promise<string>` | — | 三个请求都会带上。`files:read` 必需。 |
| `fileId` | `string` | `documentId` | `POST /api/v1/files/:id/jwt` 的 subject。 |
| `ttlSeconds` | `number` | 服务端默认(`3600`) | `30 … 86400`。越界会本地抛 `INVALID_ARGUMENT`,不发请求。 |
| `oneTime` | `boolean` | `false` | 一次性 JWT;服务端在首次校验时吊销 `jti`。 |
| `nonceTtlMs` | `number` | 服务端默认(`300_000`) | 服务端上限 1 小时。 |
| `readonly` | `boolean` | — | URL 参数 `readonly`。 |
| `locale` | `string` | — | URL 参数 `lang`。 |
| `theme` | `'light' \| 'dark' \| 'system'` | — | URL 参数 `theme`。 |
| `verifyNonce` | `boolean` | `true` | 对 mint 出来的 pair 做一次 `verify-nonce` 往返。 |
| `fetch` | `typeof fetch` | `globalThis.fetch` | 可注入,用于测试或自定义传输。 |
| `timeoutMs` | `number` | — | 作用于那三个请求。 |
| `signal` | `AbortSignal` | — | 中止那三个请求。**不会中止 `cleanup()`** —— 见下。 |
| `buildUrl` | `(input: DataflareEmbedUrlInput) => string` | `buildDataflareEmbedUrl` | 整体替换 URL 构造器。 |

只有 `app`、`readonly`、`locale`、`theme` 会进入 URL。其余字段用于选择或
认证这次会话。

### `EmbedSession`

```ts
interface EmbedSession {
  url: string            // iframe URL,内含凭证 —— 当作机密对待
  jwt: string            // 文件级 JWT
  jwtExp: number         // Unix 秒
  sessionId: string
  nonce: string
  expiresAt: number      // Unix 毫秒
  cleanup(): Promise<{ released: boolean }>
}
```

`url` 把 JWT、`sessionId`、`nonce` 作为查询参数带上。不要打日志,也不要放进
埋点 payload。

### `cleanup()`

通过 `DELETE /api/v1/embed/nonce` 逐出服务端的 nonce 会话。

- **幂等** —— 每次调用返回同一个 Promise;总共只发一次 `DELETE`。
- **best-effort** —— 传输失败或 5xx 会 resolve 成 `{ released: false }`,不抛错。
- **刻意忽略 `options.signal`**。`cleanup()` 恰恰是调用方已经 abort 时仍然
  必须执行的那个调用,因为那正是 nonce 最可能被遗弃的时刻。

如果你把会话交给了 `createEditor` 却没有传 `autoRelease: false`,编辑器会在
`destroy()` 时释放,你的调用会拿到 `{ released: false }`。这是预期行为,不是
错误——详见[嵌入会话指南](../integration/dataflarework-embed-session.md)。

## `isRetryable(code): boolean`

```ts
import { isRetryable } from '@genoffice/web-sdk/file/embed'

isRetryable('NETWORK')             // true
isRetryable('INTERNAL')            // true
isRetryable('EMBED_NONCE_INVALID') // false —— nonce 已经失效
isRetryable('FORBIDDEN')           // false
```

只有 `NETWORK` 与 `INTERNAL` 为 true。其余错误码在重试前都需要先做点什么:
换 bearer、补 scope、改参数。

## 错误

所有失败都是 `RequestError`:

```ts
class RequestError extends Error {
  readonly code: RequestErrorCode
  readonly status: number
  readonly channel: string
  readonly detail: unknown
}
```

| `code` | `channel` | 触发条件 |
|---|---|---|
| `INVALID_ARGUMENT` | `file:embed:open` | `baseUrl` / `documentId` 缺失 |
| `INVALID_ARGUMENT` | `files:jwt` / `embed:nonce` | `ttlSeconds` / `nonceTtlMs` 越界 |
| `UNAUTHENTICATED` | `files:jwt` / `embed:nonce` | 401 |
| `FORBIDDEN` | `files:jwt` / `embed:nonce` | 403,bearer 缺 `files:read` |
| `NOT_FOUND` | `files:jwt` | 404,`fileId` 对应的文件不存在 |
| `NETWORK` / `INTERNAL` | 任意 | 传输失败 / 5xx |
| `EMBED_NONCE_INVALID` | `file:embed:open` | `verify-nonce` 返回 HTTP 200 且 `{ valid: false }` |

### `EMBED_NONCE_INVALID` 是唯一需要特别留意的

`POST /api/v1/embed/verify-nonce` 对两种结果都回 **200**:

```json
{ "valid": true,  "expiresAt": 1750000000000 }
{ "valid": false, "reason": "expired" }
```

任何基于 `response.ok` 的成功判断都会把"被拒绝的握手"当成成功。
`openEmbedSession` 比较 `valid === true`,否则抛
`EMBED_NONCE_INVALID`(`reason` 为 `'unknown'` 或 `'expired'`)。抛错之前它会
先释放自己 mint 出来的会话,所以失败的握手不会留下存活的 nonce。

nonce 校验**不消费**——只有 `DELETE` 才会逐出——所以 iframe 挂载之前你可以
反复校验同一个 pair。

## 交接给 `createEditor`

```ts
const editor = createEditor({
  host, documentId, app: 'docs', jwt: session.jwt, container: '#editor',
  sessionBinding: { sessionId: session.sessionId, nonce: session.nonce },
})
```

`sessionBinding` 存在时,`createEditor` 会给 iframe URL 补上
`?sessionId=…&nonce=…`,并立即校验两个字段——
`createEditor: sessionBinding.nonce required when sessionBinding is set`
是配置错误,不是网络错误。

## 参见

- [嵌入会话指南](../integration/dataflarework-embed-session.md)
- [JavaScript SDK](./sdk-typescript.md)
- [REST API v1](./rest-api.md)
