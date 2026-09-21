# Installation

## npm packages

| Package | Purpose |
|---|---|
| `@genoffice/web-sdk` | Embeddable editor SDK (npm + UMD). |
| `@genoffice/web-server` | Standalone web server bundle. |
| `@genoffice/ai-provider` | Multi-provider LLM client. |
| `@genoffice/docx-engine` | DOCX read/write. |
| `@genoffice/pptx-engine` | PPTX read/write. |
| `@genoffice/xlsx-gateway` | XLSX read/write (via Rust sidecar). |
| `@genoffice/file-parse` | Format detection. |
| `@genoffice/file-management` | Storage backends. |
| `@genoffice/agent-core` | Agent loop protocol + types. |
| `@genoffice/translation-core` | Translation KB/TM + open formats. |
| `@genoffice/ipc-bridge` | IPC encoding / transport. |
| `@genoffice/i18n` | Localisation. |
| `@genoffice/ui` | Shared UI primitives. |

## From npm

```sh
npm install @genoffice/web-sdk
```

## From source

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server
```

The bundled server lives at `apps/web-server/dist/bundle/index.js`
(28 MB, single file).

## Docker

```sh
docker pull ghcr.io/genspark-ai/genoffice-web:latest
docker run -p 8080:8080 \
  -e GENOFFICE_JWT_SECRET=$(openssl rand -hex 32) \
  -v genoffice-data:/data \
  ghcr.io/genspark-ai/genoffice-web:latest
```

See [Deployment: Docker](/guide/deployment-docker) for compose /
kubernetes examples.

## System requirements

- 2 vCPU / 2 GB RAM minimum (the bundled server itself is ~80 MB
  resident).
- Persistent volume for `DATA_DIR` (recents, uploaded files,
  webhooks.json, snapshots).
- TLS termination in front of the Node process (Caddy / nginx).
