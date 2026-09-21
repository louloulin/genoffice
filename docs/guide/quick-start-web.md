# Quick Start: Web Server

Boot the standalone web server in 5 minutes.

## Prerequisites

- Node ≥ 22.12
- npm ≥ 10 (or pnpm ≥ 10)

## Steps

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server
PORT=8080 \
GENOFFICE_JWT_SECRET=$(openssl rand -hex 32) \
  node apps/web-server/dist/bundle/index.js
```

Open <http://localhost:8080>.

## What's running

- The server is a single Node process — no Electron, no Chrome.
- All six editors (docs, sheets, slides, pdf, markdown, html) are
  served as SPAs from `/<editor>/`.
- The REST API at `/api/v1/*` and iframe Embed at `/embed/:docId` work
  out of the box.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `8080` | TCP port to listen on. |
| `HOST` | `127.0.0.1` | Bind interface. Use `0.0.0.0` for LAN exposure. |
| `DATA_DIR` | `./.genoffice-data` | Where files and recents live. |
| `WEB_TOKEN` | _(unset)_ | Gate the IPC bridge. Strongly recommended in production. |
| `GENOFFICE_JWT_SECRET` | _(unset)_ | Sign v1 API JWTs. Without it, authed v1 routes answer 503. |
| `GENOFFICE_JWT_ALG` | `HS256` | `RS256` for asymmetric signing. |
| `WEB_CORS_ORIGINS` | _(echo Origin)_ | Comma-separated allowlist for CORS. |
| `WEB_PATH_PREFIX` | _empty_ | Strip a prefix (e.g. `/genoffice`) before routing. |

## Verifying

```sh
# health
curl http://localhost:8080/health
# {"status":"ok",...}

# v1 health (no auth)
curl http://localhost:8080/api/v1/health

# JWT mint
curl -X POST http://localhost:8080/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"test"}'

# iframe Embed
open "http://localhost:8080/embed/demo?token=$TOKEN&app=docs"
```

## What's next

- [Deployment: Docker](/guide/deployment-docker)
- [REST API](/api/rest-api)
- [Security Best Practices](/guide/security-best-practices)
