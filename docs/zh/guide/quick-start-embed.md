# 快速上手：嵌入

只需一个 `<iframe>`，就能把 GenOffice 嵌入任何网页。

## 第 1 步 · 签发 token

```sh
curl -X POST https://genoffice.app/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"user-123","ttl":3600}'
```

响应：

```json
{ "token": "eyJhbGciOi…", "exp": 1700003600, "alg": "HS256" }
```

## 第 2 步 · 构造嵌入 URL

```
GET /embed/<documentId>?token=<jwt>&app=<editor>&theme=<theme>&lang=<lang>&toolbar=<level>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `:documentId` | 是 | 后端给文档分配的 `id`。 |
| `token` | 是 | 上面签发的 JWT。 |
| `app` | 否（默认 `docs`）| `docs` / `sheets` / `slides` / `pdf` / `markdown` / `html`。 |
| `theme` | 否 | `light` / `dark` / `auto`。 |
| `lang` | 否 | `zh-CN` / `en-US` / `ja-JP`。 |
| `toolbar` | 否 | `full` / `minimal` / `none`。 |

## 第 3 步 · 用 iframe 嵌入

```html
<iframe
  id="genoffice"
  src="https://genoffice.app/embed/doc_abc?token=eyJ…&app=docs"
  style="width:100%;height:600px;border:0"
></iframe>
```

## 第 4 步 · 监听事件（可选）

```js
window.addEventListener('message', (event) => {
  if (event.data?.v !== '1.0') return
  if (event.data.kind === 'event' && event.data.payload?.name === 'ready') {
    console.log('编辑器就绪')
  }
  if (event.data.kind === 'event' && event.data.payload?.name === 'saved') {
    console.log('已保存:', event.data.payload.payload)
  }
})
```

完整事件清单见 [postMessage 协议](/zh/api/postmessage-protocol)。

## 加固建议

- **CSP。** 把 `frame-src https://genoffice.app`（或你的自部署 origin）加入 `Content-Security-Policy`。
- **短期 token。** 每个会话签一次 JWT，**永远不要**把长期凭据硬编码进 HTML。
- **文件范围 token。** 用 `POST /api/v1/files/:id/jwt` 签发只能访问单个文档的 token。

## 下一步

- [SDK 参考](/zh/api/sdk-typescript) — 类型化的事件与命令。
- [REST API](/zh/api/rest-api) — 完整 HTTP 接口。
- [安全最佳实践](/zh/guide/security-best-practices)。
