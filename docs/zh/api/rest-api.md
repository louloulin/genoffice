# REST API v1

稳定的 HTTP 接口面 — 见 sdk1.md §2.1.A。`v1.x` 内向后兼容；进入 `v2` 前保留 6 个月弃用过渡。

## 鉴权

除 `/api/v1/health`、`/api/v1/changelog` 以及 `/api/v1/auth/*` 整组外，所有端点都需要：

```http
Authorization: Bearer <jwt>
```

通过 `POST /api/v1/auth/jwt` 签发 token：

```http
POST /api/v1/auth/jwt
Content-Type: application/json

{ "sub": "user-123", "ttl": 3600 }
```

响应：`{ "token": "eyJ…", "exp": 1700003600, "alg": "HS256" }`。

用 `GENOFFICE_JWT_SECRET` 配置签名密钥。设置 `GENOFFICE_JWT_ALG=RS256` + `GENOFFICE_JWT_PRIVATE_KEY` 即可走 RS256 非对称签名。

## 错误码

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "expected { name, bytes }",
    "channel": "files:create"
  }
}
```

常见错误码：`INVALID_ARGUMENT`、`UNAUTHENTICATED`、`NOT_FOUND`、`PAYLOAD_TOO_LARGE`、`INTERNAL`、`NOT_CONFIGURED`。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET`  | `/api/v1/health` | 公开。返回实现元数据 + channel 数。 |
| `GET`  | `/api/v1/changelog` | 公开。Markdown 格式的 changelog。 |
| `POST` | `/api/v1/auth/jwt` | 签发 JWT。 |
| `POST` | `/api/v1/auth/oauth/token` | OAuth 2.0 client_credentials。 |
| `GET`  | `/api/v1/files` | 列出 FILES_DIR 内容。 |
| `POST` | `/api/v1/files` | 上传 `{name, bytes|base64}`。 |
| `GET`  | `/api/v1/files/:id` | 元数据。 |
| `DELETE` | `/api/v1/files/:id` | 删除。 |
| `POST` | `/api/v1/files/:id/jwt` | 文件范围 token。 |
| `POST` | `/api/v1/files/:id/callback` | 注册保存 webhook。 |
| `GET`  | `/api/v1/ai/capabilities` | LLM / image / search provider 快照。 |
| `POST` | `/api/v1/ai/chat` | 流式聊天（SSE）。 |
| `POST` | `/api/v1/ai/translate` | 同步批量翻译。 |
| `POST` | `/api/v1/ai/image` | 图像生成。 |
| `POST` | `/api/v1/ai/skill/:name` | 调用已注册的 Skill。 |
| `GET`  | `/api/v1/kb/search?q=...` | 搜索 KB。 |
| `GET`  | `/api/v1/kb/entries` | 列出 KB 条目。 |
| `POST` | `/api/v1/webhooks` | 注册 / 更新组织级 webhook。 |
| `DELETE` | `/api/v1/webhooks` | 移除组织级 webhook。 |
| `POST` | `/api/v1/callbacks` | 仅管理员：手动触发 callback。 |

## Webhook 信封

```http
POST <your-url>
Content-Type: application/json

{
  "v": "1.0",
  "event": "file.saved",
  "ts": 1700003600,
  "fileId": "abc.docx",
  "data": {
    "path": "/files/abc.docx",
    "size": 1234,
    "format": "docx"
  }
}
```

投递尽力而为，单次 5 秒超时。可在文件级（`POST /api/v1/files/:id/callback`）或组织级（`POST /api/v1/webhooks`）注册。

## 版本策略

- `v1.x` 在 v1 契约生命周期内冻结。允许新增可选字段；必填字段要等到 v2 才能删除。
- `v2` 提前 6 个月公告；老端点在弃用窗口内迁移到 `/api/v1/legacy/`。
