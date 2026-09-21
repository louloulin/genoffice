# 安装

## npm 包

| 包 | 用途 |
|---|---|
| `@genoffice/web-sdk` | 可嵌入编辑器 SDK（npm + UMD）。 |
| `@genoffice/web-server` | 独立 Web 服务器打包产物。 |
| `@genoffice/ai-provider` | 多 provider 的 LLM 客户端。 |
| `@genoffice/docx-engine` | DOCX 读写。 |
| `@genoffice/pptx-engine` | PPTX 读写。 |
| `@genoffice/xlsx-gateway` | XLSX 读写（经由 Rust sidecar）。 |
| `@genoffice/file-parse` | 文件格式识别。 |
| `@genoffice/file-management` | 存储后端抽象。 |
| `@genoffice/agent-core` | Agent loop 协议与类型。 |
| `@genoffice/translation-core` | 翻译 KB/TM + 开放格式。 |
| `@genoffice/ipc-bridge` | IPC 编码 / 传输。 |
| `@genoffice/i18n` | 本地化。 |
| `@genoffice/ui` | 共享 UI 原子组件。 |

## 从 npm 安装

```sh
npm install @genoffice/web-sdk
```

## 从源码构建

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server
```

打包后的服务器位于 `apps/web-server/dist/bundle/index.js`（28 MB，单文件）。

## Docker

```sh
docker pull ghcr.io/genspark-ai/genoffice-web:latest
docker run -p 8080:8080 \
  -e GENOFFICE_JWT_SECRET=$(openssl rand -hex 32) \
  -v genoffice-data:/data \
  ghcr.io/genspark-ai/genoffice-web:latest
```

Compose / Kubernetes 示例见 [部署：Docker](/guide/deployment-docker)。

## 系统要求

- 最低 2 vCPU / 2 GB RAM（独立服务器运行时占 ~80 MB 常驻）。
- 给 `DATA_DIR` 挂一块持久化卷（存放 recents、上传文件、webhooks.json、snapshots）。
- Node 进程前面挂一层 TLS 终止（Caddy / nginx）。
