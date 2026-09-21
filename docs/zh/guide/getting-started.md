# 快速开始

欢迎使用 GenOffice。本页带你以最快速度从零跑起一个本地实例。

## 你将得到什么

一个 Node.js 进程同时提供：

- 六款编辑器（docs / sheets / slides / pdf / markdown / html）的 SPA 前端。
- `/api/v1/*` REST API：上传、JWT 鉴权、AI 调用、Webhooks。
- `/embed/:docId` iframe 嵌入端点。
- 546 个 IPC 通道桥接渲染进程与主进程。

## 30 秒安装

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server     # 打包独立服务器
PORT=8080 node apps/web-server/dist/bundle/index.js
```

打开 <http://localhost:8080>。选一款编辑器，拖入文件，开始编辑保存。

## 下一步

- [快速上手：Web](/guide/quick-start-web) — 5 分钟启动本地服务器。
- [快速上手：嵌入](/guide/quick-start-embed) — 把编辑器嵌入你的站点。
- [快速上手：SDK](/guide/quick-start-sdk) — 用 TypeScript SDK 脚本化编辑器。
- [部署：Docker](/guide/deployment-docker) — 生产环境部署。

## 你需要了解的

- **Node ≥ 22.12。** 更老的 Node 版本也能运行编辑器，但打包产物使用了带 `import.meta.url` 的 ESM 模块和少量 Web API。
- **没有遥测。** 首次启动若未设置 `GENOFFICE_JWT_SECRET`，所有鉴权路由返回 `503 NOT_CONFIGURED`；其余 API 以 `open` 模式正常工作。
- **存储是本地文件系统。** 文件落在 `DATA_DIR`（默认 `./.genoffice-data`）。生产环境请把它配置为持久化卷。
