# 安全最佳实践

## 密钥管理

- **始终设置 `GENOFFICE_JWT_SECRET`。** 用 256 位随机值（`openssl rand -hex 32`）。每季度轮换。
- **设置 `WEB_TOKEN`**，任何让 IPC 桥对网络可达的环境都要设置。务必与 `GENOFFICE_JWT_SECRET` 用不同的密钥。
- **多租户部署用 RS256。** 从中心化鉴权服务签发 token，并用 `GENOFFICE_JWT_PUBLIC_KEY` 验证。

## 网络

- **跑在 TLS 后面。** 自带服务器仅 HTTP；在 Caddy / nginx / sidecar 处终止 TLS。
- **限制 CORS。** 把 `WEB_CORS_ORIGINS` 设为显式白名单（`https://app.example.com,https://admin.example.com`）。
- **在边缘丢弃未鉴权请求。** 用 nginx `limit_req` 给 `/api/v1/auth/jwt` 和 `/api/ipc/:channel` 限流。

## 文件处理

- 启动时服务端会读 `DATA_DIR` 下的所有常规文件来填充 recents。如果只需要读访问，把 `DATA_DIR` 挂成只读卷。
- iframe 嵌入端点会服务 `:docId` 对应的文件。在调用侧把 `:docId` 限定到已知前缀（如 `/embed/<prefix>-<uuid>?token=…`），防止嵌入被诱导去加载受信任区域外的文件。

## AI

- 所有 LLM / 图像 provider 都用用户自己的 API key 运行，请求不经过 GenOffice 基础设施。
- Agent Loop 有 `maxSteps` 上限（默认 8，可配到 1000），防止失控循环产生过额费用。
- Skill 执行抛结构化 `SkillError`；渲染端可以本地化错误信息，而不是直接暴露 provider 的原始错误。

## Webhooks

- 投递尽力而为，单次 5 秒超时。慢 / 5xx 目标只记日志，不让保存失败。
- Webhook URL 按字面存储；注册时务必校验（屏蔽私有 IP 段防 SSRF——`127.0.0.1`、`169.254.0.0/16`、`10.0.0.0/8` 等）。

## 漏洞上报

- 披露流程见 [`SECURITY.md`](https://github.com/genspark-ai/genoffice/blob/main/SECURITY.md)。邮件：`security@genoffice.app`。
