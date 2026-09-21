# 快速上手：Web 服务器

5 分钟启动独立的 GenOffice Web 服务器。

## 前置要求

- Node ≥ 22.12
- npm ≥ 10（或 pnpm ≥ 10）

## 步骤

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server
PORT=8080 \
GENOFFICE_JWT_SECRET=$(openssl rand -hex 32) \
  node apps/web-server/dist/bundle/index.js
```

打开 <http://localhost:8080>。

## 跑起来的是什么

- 单个 Node 进程 — 不依赖 Electron，也不依赖 Chrome。
- 六款编辑器（docs / sheets / slides / pdf / markdown / html）以 SPA 形式从 `/<editor>/` 提供。
- `/api/v1/*` REST API 与 `/embed/:docId` iframe 嵌入开箱即用。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | TCP 监听端口。 |
| `HOST` | `127.0.0.1` | 绑定网卡。LAN 暴露请设 `0.0.0.0`。 |
| `DATA_DIR` | `./.genoffice-data` | 文件与 recents 的存放目录。 |
| `WEB_TOKEN` | _(未设)_ | 给 IPC 桥加一道门禁。生产环境强烈建议设置。 |
| `GENOFFICE_JWT_SECRET` | _(未设)_ | 给 v1 API 的 JWT 签名。未设置时鉴权路由返回 503。 |
| `GENOFFICE_JWT_ALG` | `HS256` | 改为 `RS256` 即走非对称签名。 |
| `WEB_CORS_ORIGINS` | _(echo Origin)_ | CORS 允许的 origin，逗号分隔。 |
| `WEB_PATH_PREFIX` | _(空)_ | 路由前剥离前缀，例如 `/genoffice`。 |

## 验证

```sh
# 健康检查
curl http://localhost:8080/health
# {"status":"ok",...}

# v1 健康检查（无需鉴权）
curl http://localhost:8080/api/v1/health

# 签发 JWT
curl -X POST http://localhost:8080/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"test"}'

# iframe 嵌入
open "http://localhost:8080/embed/demo?token=$TOKEN&app=docs"
```

## 下一步

- [部署：Docker](/zh/guide/deployment-docker)
- [REST API](/zh/api/rest-api)
- [安全最佳实践](/zh/guide/security-best-practices)
